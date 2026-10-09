// Layered ceiling probe: separates Redis, ES, and app-layer capacity so a
// bottleneck is attributed to the right layer instead of guessed.
//
// Every number this script prints must come from a PRODUCTION build
// (npm run build && npm run start) and distinct x-forwarded-for headers per
// request — otherwise a per-IP rate limit becomes the thing under test.
//
// Run: npm run scale:layered -- --base=http://localhost:3000 --conc=10,25,50 --n=200
export {};

const parsed = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), '1'];
  })
);
const BASE = (parsed.base as string) || 'http://localhost:3000';
const ES = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';
const CONCS = String(parsed.conc || '1,10,25,50').split(',').map(Number).filter((n) => n > 0);
const N = Number(parsed.n) || 40;

function lpct(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const lmean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ES search-count delta across ALL nodes: the only trustworthy way to learn
// how many backend searches one HTTP request actually caused.
async function lEsQueryTotal(): Promise<number | null> {
  try {
    const r = await fetch(`${ES}/_nodes/stats/indices/search`);
    const j: any = await r.json();
    let t = 0;
    for (const n of Object.values<any>(j.nodes || {})) t += n?.indices?.search?.query_total || 0;
    return t;
  } catch {
    return null;
  }
}

async function lEsStats() {
  try {
    const r = await fetch(
      `${ES}/_nodes/stats/os,jvm?filter_path=nodes.*.os.cpu.percent,nodes.*.jvm.mem.heap_used_percent,nodes.*.jvm.mem.heap_used_in_bytes`
    );
    const j: any = await r.json();
    for (const n of Object.values<any>(j.nodes || {})) {
      return {
        cpu: n?.os?.cpu?.percent,
        heapPct: n?.jvm?.mem?.heap_used_percent,
        heapMB: Math.round((n?.jvm?.mem?.heap_used_in_bytes || 0) / 1048576),
      };
    }
  } catch {
    /* ignore */
  }
  return { cpu: null, heapPct: null, heapMB: null };
}

// ES search thread pool: queue/rejected are the saturation signal — sampled
// DURING load, never after, or the queue has already drained.
async function lEsThreadPool() {
  try {
    const r = await fetch(`${ES}/_nodes/stats/thread_pool?filter_path=nodes.*.thread_pool.search`);
    const j: any = await r.json();
    for (const n of Object.values<any>(j.nodes || {})) {
      const s = n?.thread_pool?.search || {};
      return { queue: s.queue, active: s.active, threads: s.threads, rejected: s.rejected };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function lRun(
  label: string,
  conc: number,
  total: number,
  fn: (i: number) => Promise<number>
) {
  const lat: number[] = [];
  let ok = 0;
  let idx = 0;
  const q0 = await lEsQueryTotal();
  const s0 = await lEsStats();
  const t0 = Date.now();
  await Promise.all(
    new Array(conc).fill(0).map(async () => {
      while (idx < total) {
        const i = idx++;
        const t = Date.now();
        try {
          const good = await fn(i);
          lat.push(Date.now() - t);
          if (good) ok++;
        } catch {
          lat.push(Date.now() - t);
        }
      }
    })
  );
  const wall = (Date.now() - t0) / 1000;
  const q1 = await lEsQueryTotal();
  const s1 = await lEsStats();
  const tp = await lEsThreadPool();
  const esQ = q0 != null && q1 != null ? q1 - q0 : null;
  return {
    label,
    conc,
    n: total,
    qps: total / Math.max(wall, 0.001),
    p50: lpct(lat, 50),
    p99: lpct(lat, 99),
    avg: Math.round(lmean(lat)),
    errPct: ((total - ok) / total) * 100,
    esSearches: esQ,
    esPerReq: esQ != null ? +(esQ / total).toFixed(2) : null,
    esCpuBefore: s0.cpu,
    esCpuAfter: s1.cpu,
    heapMB: s1.heapMB,
    threadPool: tp,
  };
}

async function lMain() {
  console.log(`=== layered ceilings  base=${BASE}  conc=[${CONCS}]  n=${N} ===`);
  const health: any = await (await fetch(`${ES}/_cluster/health`)).json();
  const st = await lEsStats();
  const tp = await lEsThreadPool();
  console.log(
    `ES: nodes=${health.number_of_nodes} primaries=${health.active_primary_shards} status=${health.status}`
  );
  console.log(
    `    heap=${st.heapMB}MB cpu=${st.cpu}% search threads=${tp?.threads ?? '?'} queue=${tp?.queue ?? '?'} rejected=${tp?.rejected ?? '?'}\n`
  );

  const tile = { minLat: 28.3, maxLat: 28.7, minLng: 76.9, maxLng: 77.3 };
  const rows: any[] = [];

  // Layer A — Redis pure ceiling. Establishes the cache layer's headroom.
  const { default: ioredis } = await import('ioredis');
  const redis = new ioredis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  await redis.set('scale:layered:probe', 'x', 'EX', 60).catch(() => {});
  for (const c of CONCS) {
    rows.push(
      await lRun(`A redis GET           c=${c}`, c, N, async () => ((await redis.get('scale:layered:probe')) ? 1 : 0))
    );
  }
  await redis.del('scale:layered:probe').catch(() => {});
  redis.disconnect();

  // Layer B — ES ceiling, using the SAME query shape the app uses.
  // request_cache is a URL parameter in the raw REST API; putting it in the
  // body is a 400, which would measure ES rejecting bad requests instead.
  const aggBody = {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        must: [],
        filter: [
          { term: { status: 'available' } },
          {
            geo_bounding_box: {
              location: { top_left: { lat: 28.7, lon: 76.9 }, bottom_right: { lat: 28.3, lon: 77.3 } },
            },
          },
        ],
      },
    },
    aggs: {
      tiles: {
        geotile_grid: {
          field: 'location',
          precision: 5,
          size: 1000,
          shard_size: 1500,
          bounds: { top_left: { lat: 28.7, lon: 76.9 }, bottom_right: { lat: 28.3, lon: 77.3 } },
        },
        aggs: { top: { top_hits: { size: 1, sort: [{ created_at: { order: 'desc' } }], _source: ['id'] } } },
      },
    },
    _source: false,
  };
  let esProbeErrors = 0;
  for (const c of CONCS) {
    rows.push(
      await lRun(`B es tile-agg         c=${c}`, c, N, async () => {
        const res = await fetch(`${ES}/properties_search/_search?request_cache=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(aggBody),
        });
        if (!res.ok) {
          esProbeErrors++;
          await res.text().catch(() => '');
          return 0;
        }
        await res.json().catch(() => {});
        return 1;
      })
    );
  }
  if (esProbeErrors) console.error(`⚠ ${esProbeErrors} ES probe errors — Layer B is invalid`);

  // Layers C/D — the map-tiles route. Distinct x-forwarded-for per request:
  // one IP would exhaust the per-IP rate limit and measure the limiter.
  const qs = 'minLat=28.3&maxLat=28.7&minLng=76.9&maxLng=77.3&zoom=11&scope=both&sort=newest';
  let ipSeq = 0;
  const nextIp = () => `10.${((ipSeq / 65536) % 256) | 0}.${((ipSeq / 256) % 256) | 0}.${ipSeq++ % 256}`;
  for (const c of CONCS) {
    rows.push(
      await lRun(`C route GET tiles     c=${c}`, c, N, async () => {
        const r = await fetch(`${BASE}/api/map-tiles?${qs}`, { headers: { 'x-forwarded-for': nextIp() } });
        if (!r.ok) await r.text().catch(() => '');
        return r.ok ? 1 : 0;
      })
    );
  }
  for (const c of CONCS) {
    rows.push(
      await lRun(`D route POST map-data c=${c}`, c, N, async () => {
        const r = await fetch(`${BASE}/api/map-data`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
          body: JSON.stringify({ bounds: tile, zoom: 11, scope: 'both', sort: 'newest', pageSize: 24 }),
        });
        if (!r.ok) await r.text().catch(() => '');
        return r.ok ? 1 : 0;
      })
    );
  }

  console.log('layer | QPS | p50 | p99 | avg | err% | ES/req | ES cpu% | heapMB | threadpool q/a');
  for (const r of rows) {
    const tp = r.threadPool;
    console.log(
      `${r.label} | ${r.qps.toFixed(1)} | p50=${r.p50} p99=${r.p99} avg=${r.avg} | err=${r.errPct.toFixed(1)}% | ` +
        `es/req=${r.esPerReq ?? '-'} | cpu ${r.esCpuBefore}%->${r.esCpuAfter}% heap=${r.heapMB}MB | ` +
        `q=${tp?.queue ?? '-'} a=${tp?.active ?? '-'}/${tp?.threads ?? '-'} rej=${tp?.rejected ?? '-'}`
    );
  }

  const best = (p: string) => rows.filter((r) => r.label.startsWith(p)).sort((a, b) => b.qps - a.qps)[0];
  const A = best('A ');
  const B = best('B ');
  const C = best('C ');
  const D = best('D ');
  console.log('\n--- bottleneck attribution ---');
  if (A) console.log(`Redis ceiling       ~${A.qps.toFixed(0)} QPS   p99=${A.p99}ms`);
  if (B) console.log(`ES ceiling (agg)    ~${B.qps.toFixed(0)} QPS   p99=${B.p99}ms`);
  if (C) console.log(`Route GET tiles     ~${C.qps.toFixed(0)} QPS   p99=${C.p99}ms  es/req=${C.esPerReq}`);
  if (D) console.log(`Route POST map-data ~${D.qps.toFixed(0)} QPS   p99=${D.p99}ms  es/req=${D.esPerReq}`);
  if (C && B && B.qps > 0) {
    const ratio = C.qps / B.qps;
    console.log(
      `\nRoute/ES ratio ${ratio.toFixed(2)} → bottleneck = ${
        ratio < 1
          ? 'APP LAYER (Next process / RTT count / serialization) — ES has headroom'
          : 'ES (reduce queries per request first, then capacity)'
      }`
    );
  }
  const saturated = rows.filter((r) => r.threadPool && r.threadPool.rejected > 0);
  if (saturated.length) console.log(`⚠ ES REJECTED searches during: ${saturated.map((r) => r.label).join(', ')}`);
}

lMain().catch((e) => {
  console.error('scale:layered failed', e);
  process.exit(1);
});
