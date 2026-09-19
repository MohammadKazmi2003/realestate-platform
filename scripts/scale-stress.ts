// Scale stress: max QPS / latency / fan-out / cache behavior.
// Run: npx tsx scripts/scale-stress.ts [--base=http://localhost:3000] [--conc=1,5,10,25,50] [--n=20]
// - If Next/ES/Redis are down, HTTP steps SKIP gracefully and fan-out math still runs.
// - Reports per-endpoint p50/p99, throughput, error%, X-Cache hit%, X-ES-Took.
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), '1'];
  })
);
const BASE = (args.base as string) || process.env.SCALE_BASE || 'http://localhost:3000';
const CONCS = String(args.conc || '1,5,10,25,50')
  .split(',')
  .map(Number)
  .filter((n) => n > 0);
const N = Number(args.n) || 20;

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function hammer(
  name: string,
  conc: number,
  n: number,
  fn: (i: number) => Promise<{ ms: number; ok: boolean; cache?: string; took?: string; status?: number }>
) {
  const lat: number[] = [];
  let ok = 0;
  let hits = 0;
  let tookSum = 0;
  let tookN = 0;
  const statuses: Record<string, number> = {};
  const t0 = Date.now();
  let idx = 0;
  const workers = new Array(conc).fill(0).map(async () => {
    while (idx < n) {
      const i = idx++;
      const t = Date.now();
      try {
        const r = await fn(i);
        lat.push(Date.now() - t);
        if (r.ok) ok++;
        if (r.cache?.includes('HIT')) hits++;
        if (r.took && Number.isFinite(Number(r.took))) {
          tookSum += Number(r.took);
          tookN++;
        }
        statuses[String(r.status ?? (r.ok ? 200 : 0))] = (statuses[String(r.status ?? (r.ok ? 200 : 0))] || 0) + 1;
      } catch {
        lat.push(Date.now() - t);
        statuses['ERR'] = (statuses['ERR'] || 0) + 1;
      }
    }
  });
  await Promise.all(workers);
  const wall = (Date.now() - t0) / 1000;
  return {
    name,
    conc,
    n,
    qps: n / Math.max(wall, 0.001),
    p50: pct(lat, 50),
    p99: pct(lat, 99),
    errPct: ((n - ok) / n) * 100,
    hitPct: (hits / Math.max(n, 1)) * 100,
    avgEsTook: tookN ? tookSum / tookN : null,
    statuses,
  };
}

async function main() {
  console.log(`=== scale-stress base=${BASE} conc=[${CONCS}] n=${N} ===\n`);

  // 0. Fan-out math (no infra needed).
  const before = 12 * 2 * 4 + 3;
  const after = 8 * 2 * 2 + 3;
  console.log(`Fan-out worst cold pan (scope=both): ${before} → ${after} ES searches (~${Math.round((1 - after / before) * 100)}% cut).`);
  console.log(`Merge per tile at 20 shards: 20*5000=100k → 20*1500=30k candidates (~3.3x cheaper).\n`);

  // 1. Liveness probe.
  let live = false;
  try {
    const r = await fetch(`${BASE}/api/map-tiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bounds: { minLat: 28.3, maxLat: 28.7, minLng: 76.9, maxLng: 77.3 }, zoom: 11 }),
      signal: AbortSignal.timeout(8000),
    });
    live = r.status !== 404;
    console.log(`probe POST /api/map-tiles → ${r.status} (live=${live})`);
  } catch (e: any) {
    console.log(`probe failed (${e?.message || e}) — HTTP load SKIPPED, math only. Start app with: npm run dev`);
  }
  if (!live) {
    console.log('\nWhat to test when live:');
    console.log('- GET /api/map-tiles?minLat..&zoom (CDN s-maxage, X-Cache)');
    console.log('- GET /api/project-groups?... (lazy pills, long TTL)');
    console.log('- POST /api/map-data (list+markers, singleflight)');
    console.log('- Sweep conc to find error%<5% && p99<2000ms knee = max sustainable QPS.');
    return;
  }

  const tileBody = { bounds: { minLat: 28.3, maxLat: 28.7, minLng: 76.9, maxLng: 77.3 }, zoom: 11, scope: 'both', sort: 'newest' };
  const tileQS = 'minLat=28.3&maxLat=28.7&minLng=76.9&maxLng=77.3&zoom=11&scope=both&sort=newest';

  // 2. Correctness gates (400s must not 500).
  for (const [nm, init] of [
    ['bad-bounds', { method: 'POST', url: `${BASE}/api/map-tiles`, body: JSON.stringify({ zoom: 11 }) }],
    ['bad-groups', { method: 'GET', url: `${BASE}/api/project-groups?zoom=11` }],
  ] as const) {
    const r = await fetch(init.url, {
      method: init.method,
      headers: { 'content-type': 'application/json' },
      ...(init.method === 'POST' ? { body: (init as any).body } : {}),
    });
    console.log(`gate ${nm} → ${r.status} (expect 400) ${r.status === 400 ? 'PASS' : 'CHECK'}`);
  }

  // 3. Sweeps.
  const rows: any[] = [];
  for (const c of CONCS) {
    rows.push(
      await hammer(`GET map-tiles c=${c}`, c, N, async () => {
        const t = Date.now();
        const r = await fetch(`${BASE}/api/map-tiles?${tileQS}`, { signal: AbortSignal.timeout(15000) });
        await r.text().catch(() => '');
        return { ms: Date.now() - t, ok: r.ok, cache: r.headers.get('x-cache') || '', took: r.headers.get('x-es-took') || '', status: r.status };
      })
    );
    rows.push(
      await hammer(`POST map-tiles c=${c}`, c, N, async () => {
        const t = Date.now();
        const r = await fetch(`${BASE}/api/map-tiles`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(tileBody),
          signal: AbortSignal.timeout(15000),
        });
        await r.text().catch(() => '');
        return { ms: Date.now() - t, ok: r.ok, cache: r.headers.get('x-cache') || '', took: r.headers.get('x-es-took') || '', status: r.status };
      })
    );
  }
  // Project-groups once per conc (lighter).
  for (const c of [CONCS[0], CONCS[CONCS.length - 1]]) {
    rows.push(
      await hammer(`GET project-groups c=${c}`, c, Math.max(5, Math.floor(N / 2)), async () => {
        const t = Date.now();
        const r = await fetch(`${BASE}/api/project-groups?${tileQS}`, { signal: AbortSignal.timeout(15000) });
        await r.text().catch(() => '');
        return { ms: Date.now() - t, ok: r.ok, cache: r.headers.get('x-cache') || '', status: r.status };
      })
    );
  }

  console.log('\nendpoint | conc | qps | p50ms | p99ms | err% | hit% | avgEsTook | statuses');
  for (const r of rows) {
    console.log(
      `${r.name} | qps=${r.qps.toFixed(1)} p50=${r.p50.toFixed(0)} p99=${r.p99.toFixed(0)} err=${r.errPct.toFixed(1)}% hit=${r.hitPct.toFixed(0)}% es=${r.avgEsTook != null ? r.avgEsTook.toFixed(0) : '-'} ${JSON.stringify(r.statuses)}`
    );
  }
  const sustainable = rows.filter((r) => r.errPct < 5 && r.p99 < 2000).sort((a, b) => b.qps - a.qps)[0];
  console.log(
    sustainable
      ? `\nMax sustainable (err<5% && p99<2s): ${sustainable.name} ≈ ${sustainable.qps.toFixed(1)} qps.`
      : '\nNo conc met err<5% && p99<2s — scale ES replicas/nodes (env only) or raise TILE_CONCURRENCY/Redis.'
  );
  console.log('Notes: 429=rate-limited (Upstash rl:map 60/min/ip); 503=ES down/circuit; warm rerun should show hit%↑ p99↓.');
}

main().catch((e) => {
  console.error('stress crashed', e);
  process.exit(1);
});
