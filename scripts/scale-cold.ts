// Cold-path probe: a UNIQUE viewport per request, so every request misses the
// response cache and pays the full backend path. This is the honest worst case
// and the one that determines how many ES searches per second the fleet needs.
//
// Run: npm run scale:cold -- --base=http://localhost:3000 --conc=10,25,50 --n=200
export {};

const parsed = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), '1'];
  })
);
const BASE = (parsed.base as string) || 'http://localhost:3000';
const ES = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const CONCS = String(parsed.conc || '10,25,50').split(',').map(Number).filter((n) => n > 0);
const N = Number(parsed.n) || 200;

function cpct(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
async function cEsQueryTotal(): Promise<number | null> {
  try {
    const j: any = await (await fetch(`${ES}/_nodes/stats/indices/search`)).json();
    let t = 0;
    for (const n of Object.values<any>(j.nodes || {})) t += n?.indices?.search?.query_total || 0;
    return t;
  } catch {
    return null;
  }
}
async function cEsThreadPool() {
  try {
    const j: any = await (await fetch(`${ES}/_nodes/stats/thread_pool?filter_path=nodes.*.thread_pool.search`)).json();
    for (const n of Object.values<any>(j.nodes || {})) {
      const s = n?.thread_pool?.search || {};
      return { queue: s.queue, active: s.active, threads: s.threads, rejected: s.rejected };
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Tile-union keys mean a small jitter inside one tile reuses the same cache
// entry — which is the feature, but it would make "cold" measure the warm path.
// To force genuine misses, spread across a country-sized region AND vary zoom
// (zoom changes the tile set, so the key changes too). Deterministic seed keeps
// runs comparable.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function randomBounds(spanDeg: number) {
  const d = spanDeg / 2;
  // Sampled across India (country-sized) so consecutive requests never resolve
  // to the same covering-tile union.
  const lat = 8 + rnd() * 25;
  const lng = 68 + rnd() * 22;
  return {
    minLat: lat - d,
    maxLat: lat + d,
    minLng: lng - d,
    maxLng: lng + d,
  };
}
// Zoom in 6..13 so even repeated coordinates produce a different tile set.
function randomZoom(base: number) {
  return Math.max(6, Math.min(13, base + (Math.floor(rnd() * 5) - 2)));
}

async function cRun(
  label: string,
  conc: number,
  total: number,
  path: 'GET' | 'POST',
  span: number,
  zoom: number,
  scope: string,
  randomizeZoom = true
) {
  const lat: number[] = [];
  const statuses: Record<string, number> = {};
  let ok = 0;
  let idx = 0;
  let ip = 0;
  const q0 = await cEsQueryTotal();
  const t0 = Date.now();
  await Promise.all(
    new Array(conc).fill(0).map(async () => {
      while (idx < total) {
        idx++;
        const b = randomBounds(span);
        const z = randomizeZoom ? randomZoom(zoom) : zoom;
        const xff = {
          'x-forwarded-for': `172.${((ip / 65536) % 256) | 0}.${((ip / 256) % 256) | 0}.${ip++ % 256}`,
        };
        const t = Date.now();
        try {
          const res =
            path === 'GET'
              ? await fetch(
                  `${BASE}/api/map-tiles?minLat=${b.minLat}&maxLat=${b.maxLat}&minLng=${b.minLng}&maxLng=${b.maxLng}&zoom=${z}&scope=${scope}&sort=newest`,
                  { headers: xff }
                )
              : await fetch(`${BASE}/api/map-data`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...xff },
                  body: JSON.stringify({ bounds: b, zoom: z, scope, sort: 'newest', pageSize: 24 }),
                });
          lat.push(Date.now() - t);
          statuses[res.status] = (statuses[res.status] || 0) + 1;
          if (res.ok) ok++;
          await res.text().catch(() => '');
        } catch {
          lat.push(Date.now() - t);
          statuses.ERR = (statuses.ERR || 0) + 1;
        }
      }
    })
  );
  const wall = (Date.now() - t0) / 1000;
  const q1 = await cEsQueryTotal();
  const tp = await cEsThreadPool();
  return {
    label,
    conc,
    n: total,
    qps: +(total / Math.max(wall, 0.001)).toFixed(1),
    p50: cpct(lat, 50),
    p99: cpct(lat, 99),
    err: +(((total - ok) / total) * 100).toFixed(1),
    esPerReq: q0 != null && q1 != null ? +((q1 - q0) / total).toFixed(2) : null,
    statuses,
    threadPool: tp,
  };
}

async function cMain() {
  console.log(`=== COLD path (unique viewport per request)  base=${BASE} ===`);
  console.log('Every request = response-cache miss = full backend path.\n');
  const rows: any[] = [];
  for (const c of CONCS) rows.push(await cRun(`tiles GET  both  z~11 c=${c}`, c, N, 'GET', 0.02, 11, 'both'));
  for (const c of CONCS) rows.push(await cRun(`tiles GET  props z~11 c=${c}`, c, N, 'GET', 0.02, 11, 'properties'));
  for (const c of CONCS) rows.push(await cRun(`tiles GET  both  z~8  c=${c}`, c, N, 'GET', 0.4, 8, 'both'));
  for (const c of CONCS) rows.push(await cRun(`map-data  both  z~11 c=${c}`, c, N, 'POST', 0.02, 11, 'both'));

  console.log('case | QPS | p50 | p99 | err% | ES/req | statuses');
  for (const r of rows) {
    console.log(
      `${r.label} | ${r.qps} | p50=${r.p50} p99=${r.p99} | err=${r.err}% | es/req=${r.esPerReq ?? '-'} | ${JSON.stringify(r.statuses)}`
    );
  }

  const hottest = rows.reduce((a, b) => ((b.esPerReq ?? 0) > (a.esPerReq ?? 0) ? b : a));
  const fastest = rows.reduce((a, b) => (a.qps > b.qps ? a : b));
  console.log(`\nMax cold QPS: ${fastest.qps} (${fastest.label})`);
  console.log(`Worst fan-out: ${hottest.esPerReq} ES searches/request (${hottest.label})`);
  const demand = rows.reduce((a, r) => a + r.qps * (r.esPerReq ?? 0), 0);
  console.log(`Aggregate ES demand at these levels ≈ ${demand.toFixed(0)} searches/sec`);
  const rej = rows.filter((r) => r.threadPool && r.threadPool.rejected > 0);
  if (rej.length) console.log(`⚠ ES REJECTED searches during: ${rej.map((r) => r.label).join(', ')}`);
}

cMain().catch((e) => {
  console.error('scale:cold failed', e);
  process.exit(1);
});
