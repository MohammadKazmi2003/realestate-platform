// Sorting cost matrix: list / tile / fill per sort, profiled with the shipped
// builders at a chosen corpus. Measures collector CPU for each sort and shows
// where `missing:_last`, mixed-scope unmapped fields, and full-population
// top-k collection are paid.
//
// Usage:
//   ES_PROPERTIES_INDEX=bench_props_5m ES_PROJECTS_INDEX=bench_projects_5m \
//   ES_TILES_INDEX=bench_tile_5m npx tsx scripts/bench-sort-cost.ts --label=5m --runs=7
import { writeFileSync, mkdirSync } from 'fs';
import { getElasticsearchClient, TILES_INDEX_ALIAS } from '@/lib/elasticsearch';
import { buildFilters, buildListQuery } from '@/lib/esQueryBuilder';
import { buildTileAggQuery, querySortFillForBounds } from '@/lib/esTileMarkers';
import { parseProfile, median, medianMaps } from './lib/profile';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const LABEL = String(args.label || 'x');
const RUNS = Number(args.runs || 7);
const WARMUP = 2;

const es: any = getElasticsearchClient();
const ALL_SORTS = ['newest', 'price_asc', 'price_desc', 'beds', 'baths', 'sqft', 'lot', 'popular'];
const SORTS = args.sorts ? String(args.sorts).split(',') : ALL_SORTS;

const ALL_VIEWPORTS: { name: string; bounds: any; zoom: number; precision: number }[] = [
  { name: 'delhi_z11', bounds: { minLat: 28.30, maxLat: 28.80, minLng: 76.90, maxLng: 77.50 }, zoom: 11, precision: 9 },
  { name: 'dubai_z10', bounds: { minLat: 24.95, maxLat: 25.45, minLng: 55.05, maxLng: 55.55 }, zoom: 10, precision: 6 },
  { name: 'country_z4', bounds: { minLat: 8.0, maxLat: 35.0, minLng: 54.0, maxLng: 97.0 }, zoom: 4, precision: 6 },
];
const VIEWPORTS = args.viewports
  ? ALL_VIEWPORTS.filter((v) => String(args.viewports).split(',').includes(v.name))
  : ALL_VIEWPORTS;

async function run(fn: () => Promise<any>, q: any, opts: any = {}) {
  const runs: any[] = [];
  for (let i = 0; i < RUNS + WARMUP; i++) {
    let profile: any = null;
    let took = 0;
    let wall = 0;
    const orig = es.search;
    es.search = async (body: any, ...rest: any[]) => {
      const res: any = await orig.call(es, { index: body.index || TILES_INDEX_ALIAS, ...body, profile: true, request_cache: false }, ...rest);
      profile = res.profile; took = res.took;
      return res;
    };
    const t0 = performance.now();
    try { await fn(); } finally { es.search = orig; }
    wall = performance.now() - t0;
    if (i >= WARMUP) runs.push({ wall, took, parsed: parseProfile(profile) });
  }
  const med = (f: (r: any) => number) => median(runs.map(f));
  const aggKeys = new Set(runs.flatMap((r) => Object.keys(r.parsed.collectorChildren)));
  const children: Record<string, number> = {};
  for (const k of aggKeys) children[k] = median(runs.map((r) => r.parsed.collectorChildren[k] || 0));
  return {
    wallMs: med((r) => r.wall),
    tookMs: med((r) => r.took),
    queryMs: med((r) => r.parsed.queryMs),
    collectMs: med((r) => r.parsed.collectorMs),
    fetchMs: med((r) => r.parsed.fetchMs),
    cpuMs: med((r) => r.parsed.totalShardCpuMs),
    leaves: medianMaps(runs.map((r) => r.parsed.queryLeaves)),
    children: Object.fromEntries(Object.entries(children).sort((a, b) => b[1] - a[1])),
    aggs: medianMaps(runs.map((r) => r.parsed.aggs)),
  };
}

async function main() {
  console.log(`# sort cost corpus=${LABEL} tiles=${TILES_INDEX_ALIAS} runs=${RUNS}`);
  const out: any = { label: LABEL, runs: RUNS, viewports: {} };

  for (const vp of VIEWPORTS) {
    const vpOut: any = { sorts: {} };
    console.log(`\n## ${vp.name}`);
    console.log('sort         kind   wall   took   cpu |   query  collect   fetch | top collectors');
    for (const sort of SORTS) {
      const { must, filters } = buildFilters({ bounds: vp.bounds, scope: 'both', sort }, 'both');

      const listQ = buildListQuery({ bounds: vp.bounds, scope: 'both', sort, pageSize: 24 });
      const list = await run(async () => { await es.search(listQ); }, listQ);

      const tileQ = buildTileAggQuery({ tileBounds: vp.bounds, must, filters, scope: 'both', sort, zoom: vp.zoom, precision: vp.precision } as any);
      const tile = await run(async () => { await es.search({ index: TILES_INDEX_ALIAS, ...tileQ }); }, tileQ);

      const fill = await run(async () => { await querySortFillForBounds({ must, filters, scope: 'both', sort, size: 500, timeoutMs: 8000 } as any); }, null);

      vpOut.sorts[sort] = { list, tile, fill };
      for (const [kind, r] of [['list', list], ['tile', tile], ['fill', fill]] as const) {
        const coll = Object.entries<any>(r.children).slice(0, 2).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ');
        console.log(`${sort.padEnd(12)} ${kind.padEnd(5)} ${r.wallMs.toFixed(1).padStart(6)} ${r.tookMs.toFixed(1).padStart(6)} ${r.cpuMs.toFixed(1).padStart(6)} | ${r.queryMs.toFixed(1).padStart(7)} ${r.collectMs.toFixed(1).padStart(7)} ${r.fetchMs.toFixed(1).padStart(7)} | ${coll}`);
      }
    }
    out.viewports[vp.name] = vpOut;
  }

  mkdirSync('bench-results', { recursive: true });
  const file = `bench-results/sort-cost-${LABEL}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n# wrote ${file}`);
}

main().catch((e) => { console.error(e?.meta?.body || e); process.exit(1); });
