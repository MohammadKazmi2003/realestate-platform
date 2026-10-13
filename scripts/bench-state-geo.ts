// Per-state geometry-filter cost benchmark (Phase 4 evidence).
//
// Measures, for all 43 canonical regions:
//   es_cold  — direct ES size:0 count with request_cache=false (geometry
//              evaluation cost of the exact server clause)
//   es_warm  — same query with the shard request cache allowed
//   api_cold — /api/state-counts after flushing the app cache (full request:
//              canonical geometry read + clause build + token-reduced key hash
//              + ES + envelope)
//   api_warm — immediate repeat (Redis hit path)
// plus payload sizes (raw/gzip) and a hash-cost comparison with and without the
// region token (the token replaces the megabyte geometry in cache keys).
//
// Usage: npx tsx scripts/bench-state-geo.ts [--base=http://localhost:3000]
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { gzipSync } from 'zlib';
import { listAdminRegions, type AdminRegion } from '@/lib/adminRegionsServer';
import { boundaryClauseFromShapes, buildFilters, buildCountCacheKey } from '@/lib/esQueryBuilder';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const BASE = String(args.base || 'http://localhost:3000');
const ES = String(args.es || process.env.ELASTICSEARCH_URL || 'http://localhost:9200');
const INDEXES = 'properties_search,projects_search';

let ipCounter = 0;
const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const ms = (t: number) => Math.round(t * 10) / 10;
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

function countQuery(clause: any) {
  return {
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: [{ term: { status: 'available' } }, clause] } },
  };
}

async function esCount(clause: any, requestCache: boolean): Promise<number> {
  const res = await fetch(`${ES}/${INDEXES}/_search?request_cache=${requestCache}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(countQuery(clause)),
  });
  if (!res.ok) throw new Error(`ES ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  return json?.hits?.total?.value ?? json?.hits?.total ?? 0;
}

async function apiCount(id: string): Promise<number> {
  const res = await fetch(`${BASE}/api/state-counts?state=${encodeURIComponent(id)}&scope=both`, {
    headers: { 'x-forwarded-for': nextIp() },
  });
  if (!res.ok) throw new Error(`api ${res.status}`);
  const json: any = await res.json();
  return json.total;
}

function flushAppCache() {
  execFileSync('node', ['scripts/flush-app-cache.mjs'], { stdio: 'ignore' });
}

function hashCost(id: string, region: AdminRegion, withToken: boolean): number {
  const params = withToken
    ? { polygonsWithHoles: region.shapes, regionToken: region.token }
    : { polygonsWithHoles: region.shapes };
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const { must, filters } = buildFilters(params, 'both');
    buildCountCacheKey(must, filters, withToken ? region.token : undefined);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[1];
}

async function main() {
  console.log(`# per-state geometry filter benchmark  base=${BASE}  es=${ES}`);
  const regions = listAdminRegions();
  const rows: any[] = [];

  for (const region of regions) {
    const clause = boundaryClauseFromShapes(region.shapes)!;
    const filePath = `public/geo/${`regions/${region.id}.geojson`}`;
    const raw = readFileSync(filePath);
    const gz = gzipSync(raw, { level: 6 }).length;

    const esCold = await timed(() => esCount(clause, false));
    const esWarm = await timed(() => esCount(clause, true));

    flushAppCache();
    const apiCold = await timed(() => apiCount(region.id));
    const apiWarm = await timed(() => apiCount(region.id));

    const consistent = esCold.value === apiCold.value && apiCold.value === apiWarm.value;
    rows.push({
      id: region.id,
      name: region.name,
      points: region.points,
      rings: region.ringCount,
      holes: region.holeCount,
      rawKB: Math.round(raw.length / 1024),
      gzipKB: Math.round(gz / 1024),
      esColdMs: esCold.ms,
      esWarmMs: esWarm.ms,
      apiColdMs: apiCold.ms,
      apiWarmMs: apiWarm.ms,
      count: esCold.value,
      consistent,
    });
    console.log(
      `${region.id.padEnd(6)} ${String(region.points).padStart(6)} pts ${String(region.ringCount).padStart(3)} rings ${String(region.holeCount).padStart(2)} holes ` +
      `${String(Math.round(raw.length / 1024)).padStart(5)}K/${String(Math.round(gz / 1024)).padStart(4)}K gz  ` +
      `esCold=${esCold.ms.toFixed(0).padStart(5)}ms esWarm=${esWarm.ms.toFixed(0).padStart(4)}ms ` +
      `apiCold=${apiCold.ms.toFixed(0).padStart(5)}ms apiWarm=${apiWarm.ms.toFixed(0).padStart(4)}ms count=${esCold.value}${consistent ? '' : '  INCONSISTENT'}`
    );
  }

  const sorted = rows.slice().sort((a, b) => b.esColdMs - a.esColdMs);
  const p = (arr: number[], q: number) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  };
  const esColdVals = rows.map((r) => r.esColdMs);
  const esWarmVals = rows.map((r) => r.esWarmMs);
  const apiColdVals = rows.map((r) => r.apiColdMs);
  const apiWarmVals = rows.map((r) => r.apiWarmMs);

  console.log('\n--- slowest cold ES geometry counts ---');
  for (const r of sorted.slice(0, 12)) {
    console.log(`${r.id.padEnd(6)} ${String(r.points).padStart(6)} pts  esCold=${r.esColdMs.toFixed(0)}ms apiCold=${r.apiColdMs.toFixed(0)}ms apiWarm=${r.apiWarmMs.toFixed(0)}ms`);
  }

  // Token-reduced hashing: without it every state request re-hashes the full
  // geometry multiple times (list + marker + tile + count keys).
  const heaviest = rows.slice().sort((a, b) => b.points - a.points)[0];
  const heaviestRegion = regions.find((r) => r.id === heaviest.id)!;
  const hashWith = hashCost(heaviest.id, heaviestRegion, true);
  const hashWithout = hashCost(heaviest.id, heaviestRegion, false);

  const inconsistent = rows.filter((r) => !r.consistent);
  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    regions: rows,
    summary: {
      esColdMs: { p50: p(esColdVals, 0.5), p95: p(esColdVals, 0.95), max: Math.max(...esColdVals) },
      esWarmMs: { p50: p(esWarmVals, 0.5), p95: p(esWarmVals, 0.95), max: Math.max(...esWarmVals) },
      apiColdMs: { p50: p(apiColdVals, 0.5), p95: p(apiColdVals, 0.95), max: Math.max(...apiColdVals) },
      apiWarmMs: { p50: p(apiWarmVals, 0.5), p95: p(apiWarmVals, 0.95), max: Math.max(...apiWarmVals) },
      inconsistentCounts: inconsistent.length,
      heaviestHashMs: { withToken: heaviest.id, withTokenMs: ms(hashWith), withoutTokenMs: ms(hashWithout) },
    },
  };
  mkdirSync('bench-results', { recursive: true });
  writeFileSync('bench-results/state-geo-latency.json', JSON.stringify(summary, null, 2));

  console.log('\n--- summary (ms) ---');
  console.log(`es cold  p50=${summary.summary.esColdMs.p50.toFixed(0)} p95=${summary.summary.esColdMs.p95.toFixed(0)} max=${summary.summary.esColdMs.max.toFixed(0)}`);
  console.log(`es warm  p50=${summary.summary.esWarmMs.p50.toFixed(0)} p95=${summary.summary.esWarmMs.p95.toFixed(0)} max=${summary.summary.esWarmMs.max.toFixed(0)}`);
  console.log(`api cold p50=${summary.summary.apiColdMs.p50.toFixed(0)} p95=${summary.summary.apiColdMs.p95.toFixed(0)} max=${summary.summary.apiColdMs.max.toFixed(0)}`);
  console.log(`api warm p50=${summary.summary.apiWarmMs.p50.toFixed(0)} p95=${summary.summary.apiWarmMs.p95.toFixed(0)} max=${summary.summary.apiWarmMs.max.toFixed(0)}`);
  console.log(`hash build+key (${heaviest.id}, ${heaviest.points} pts): withToken=${hashWith.toFixed(1)}ms withoutToken=${hashWithout.toFixed(1)}ms`);
  console.log(`counts consistent across es/api cold/warm: ${inconsistent.length === 0 ? 'yes' : `NO — ${inconsistent.map((r) => r.id).join(',')}`}`);
  console.log('wrote bench-results/state-geo-latency.json');
  if (inconsistent.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
