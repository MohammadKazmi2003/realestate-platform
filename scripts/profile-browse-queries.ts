// Per-query ES profile harness for the /browse paths.
//
// Runs the SHIPPED query builders against a chosen corpus with profile:true and
// decomposes each query's shard-level CPU into phases: rewrite, query clauses
// (term/range/geo/score), collectors (sort/top-k/aggregations), and fetch.
//
// Usage:
//   ES_PROPERTIES_INDEX=bench_props_100k ES_PROJECTS_INDEX=bench_projects_100k \
//   ES_TILES_INDEX=bench_tile_100k npx tsx scripts/profile-browse-queries.ts --label=100k --runs=11
//
// Notes:
// - Profile times are CPU nanos summed across shards (they overlap in wall
//   time). `took` is wall. Percentages are "% of aggregate shard CPU".
// - Run shapes via the real builders; for functions that execute internally
//   (legacy markers, tile agg, fill, pills) the client's search() is wrapped to
//   inject profile:true so the shipped shape is measured, not a copy.
// - Text/autocomplete shapes are excluded on lean corpora (no analyzed fields).
import { mkdirSync, writeFileSync } from 'fs';
import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS, TILES_INDEX_ALIAS } from '@/lib/elasticsearch';
import {
  buildCountQuery,
  buildFilters,
  buildListQuery,
  queryESMapMarkers,
  queryESProjectGroups,
} from '@/lib/esQueryBuilder';
import { buildTileAggQuery, querySortFillForBounds } from '@/lib/esTileMarkers';
import { precisionForZoom } from '@/lib/mapTiles';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const LABEL = String(args.label || 'live');
const RUNS = Number(args.runs || 11);
const WARMUP = Number(args.warmup || 2);
const OUT_DIR = 'bench-results';
const SHARD_STATS = args['shard-stats'] !== 'false';
const ES_URL = String(process.env.ELASTICSEARCH_URL || 'http://localhost:9200');

const es: any = getElasticsearchClient();

// Per-shard search.query_total from _stats?level=shards (direct REST; the JS
// client has no level=shards metric shortcut). Returns `index:shard` -> count.
async function shardQueryTotals(indexPattern: string | string[]): Promise<Record<string, number>> {
  const idx = Array.isArray(indexPattern) ? indexPattern.join(',') : indexPattern;
  const res = await fetch(
    `${ES_URL}/${idx}/_stats/search?level=shards&filter_path=indices.*.shards.*.search.query_total`
  );
  const j: any = await res.json();
  const out: Record<string, number> = {};
  for (const [name, v] of Object.entries<any>(j.indices || {})) {
    for (const [shard, entries] of Object.entries<any>(v.shards || {})) {
      // Each shard id maps to an ARRAY of copies (primary [+ replicas]).
      const list = Array.isArray(entries) ? entries : [entries];
      for (const e of list) {
        out[`${name}:${shard}${e.primary === false ? 'r' : ''}`] = e.search?.query_total || 0;
      }
    }
  }
  return out;
}

// ---- profile execution helpers -------------------------------------------------

type ProfiledRun = { wallMs: number; tookMs: number; profile: any };

async function runProfiled(query: any, opts: any = {}): Promise<ProfiledRun> {
  const t0 = performance.now();
  const res: any = await es.search({ ...query, profile: true, ...opts });
  const wallMs = performance.now() - t0;
  return { wallMs, tookMs: res.took, profile: res.profile };
}

// Wrap the client search once so builder-internal executions are profiled too.
async function runViaBuilder(fn: () => Promise<any>): Promise<ProfiledRun> {
  const orig = es.search;
  let profile: any = null;
  let tookMs = 0;
  es.search = async (q: any, ...rest: any[]) => {
    const res = await orig.call(es, { ...q, profile: true, request_cache: false }, ...rest);
    profile = res.profile ?? profile;
    tookMs = res.took ?? tookMs;
    return res;
  };
  const t0 = performance.now();
  try {
    await fn();
  } finally {
    es.search = orig;
  }
  return { wallMs: performance.now() - t0, tookMs, profile };
}

// ---- profile parsing ------------------------------------------------------------

const WRAPPERS = new Set([
  'BooleanQuery', 'ConstantScoreQuery', 'BoostingQuery', 'DisjunctionMaxQuery',
  'FunctionScoreQuery', 'BoostQuery',
]);

function categorize(type: string): string {
  if (/LatLon|Geo|PointInSet|Shape|Distance/.test(type)) return 'geo';
  if (/Range|IndexOrDocValues/.test(type)) return 'range';
  if (/Term|MatchAll|Exists|Wildcard|Regexp|Prefix|Fuzzy|Ids/.test(type)) return 'filter_term';
  if (/FunctionScore/.test(type)) return 'function_score';
  if (/MultiTerm|Match|Phrase|Disjunction|Boolean|ConstantScore/.test(type)) return 'text_or_bool';
  return 'other';
}

function leafAttribution(node: any, out: Record<string, number>) {
  if (!node || typeof node !== 'object') return;
  const type: string = node.type || 'unknown';
  if (WRAPPERS.has(type) && Array.isArray(node.children) && node.children.length > 0) {
    for (const c of node.children) leafAttribution(c.query ?? c, out);
    return;
  }
  const key = categorize(type);
  out[key] = (out[key] || 0) + (node.time_in_nanos || 0);
}

function parseProfile(profile: any) {
  const queryClauses: Record<string, number> = {};
  const queryLeaves: Record<string, number> = {};
  const collectors: Record<string, number> = {};
  const collectorChildren: Record<string, number> = {};
  const aggs: Record<string, number> = {};
  let rewrite = 0;
  let queryMs = 0;
  let collector = 0;
  let fetch = 0;
  let shardCount = 0;

  for (const s of profile?.shards || []) {
    shardCount++;
    for (const srch of s.searches || []) {
      rewrite += srch.rewrite_time || 0;
      for (const q of srch.query || []) {
        queryMs += q.time_in_nanos || 0;
        const t = q.type || 'unknown';
        queryClauses[t] = (queryClauses[t] || 0) + (q.time_in_nanos || 0);
        leafAttribution(q, queryLeaves);
      }
      for (const c of srch.collector || []) {
        collector += c.time_in_nanos || 0;
        collectors[c.name || 'unknown'] = (collectors[c.name || 'unknown'] || 0) + (c.time_in_nanos || 0);
        // Deep walk so aggregator names are visible under AggregatorCollector.
        // Parent times include children — read this as attribution, not a sum.
        const walk = (node: any) => {
          for (const ch of node.children || []) {
            const n = ch.name || 'unknown';
            collectorChildren[n] = (collectorChildren[n] || 0) + (ch.time_in_nanos || 0);
            walk(ch);
          }
        };
        walk(c);
      }
    }
    for (const a of s.aggregations || []) {
      const t = a.type || 'unknown';
      aggs[t] = (aggs[t] || 0) + (a.time_in_nanos || 0);
    }
    if (s.fetch) fetch += s.fetch.time_in_nanos || 0;
  }
  const totalCpu = rewrite + queryMs + collector + fetch;
  return {
    shardCount,
    rewriteMs: rewrite / 1e6,
    queryMs: queryMs / 1e6,
    collectorMs: collector / 1e6,
    fetchMs: fetch / 1e6,
    totalShardCpuMs: totalCpu / 1e6,
    queryClauses: nsMap(queryClauses),
    queryLeaves: nsMap(queryLeaves),
    collectors: nsMap(collectors),
    collectorChildren: nsMap(collectorChildren),
    aggs: nsMap(aggs),
  };
}

const nsMap = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / 1e6]).sort((a, b) => b[1] - a[1]));

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function medianMaps(maps: Record<string, number>[]): Record<string, number> {
  const keys = new Set<string>();
  for (const m of maps) for (const k of Object.keys(m)) keys.add(k);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = median(maps.map((m) => m[k] || 0));
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

// ---- query shapes ----------------------------------------------------------------

const DELHI = { minLat: 28.30, maxLat: 28.80, minLng: 76.90, maxLng: 77.50 };
const DUBAI = { minLat: 24.95, maxLat: 25.45, minLng: 55.05, maxLng: 55.55 };
const COUNTRY = { minLat: 8.0, maxLat: 35.0, minLng: 54.0, maxLng: 97.0 };

type Shape = { name: string; index: string; exec: () => Promise<ProfiledRun> };

function listShape(name: string, bounds: any, params: any): Shape {
  const q = buildListQuery({ bounds, pageSize: 24, ...params });
  return { name, index: String(q.index), exec: () => runProfiled(q) };
}

function countShape(name: string, bounds: any, scope: string, params: any = {}): Shape {
  const { must, filters } = buildFilters({ bounds, ...params }, scope);
  const q = buildCountQuery(must, filters, scope);
  // request_cache off for profiling: a cached size:0 request is served without
  // profile data and would record zeros, hiding the count's real CPU cost.
  return { name, index: String(q.index), exec: () => runProfiled(q, { request_cache: false }) };
}

function tileShape(name: string, bounds: any, zoom: number, scope: string, sort: string): Shape {
  const { must, filters } = buildFilters({ bounds, scope, sort }, scope);
  const q = buildTileAggQuery({ tileBounds: bounds, must, filters, scope, sort, zoom });
  return {
    name,
    index: TILES_INDEX_ALIAS,
    // buildTileAggQuery returns a body only; the route supplies the index.
    exec: () => runProfiled({ index: TILES_INDEX_ALIAS, ...q }, { request_cache: false, allow_partial_search_results: true }),
  };
}

function legacyMarkerShape(name: string, bounds: any, scope: string, sort: string): Shape {
  const { must, filters } = buildFilters({ bounds, scope, sort }, scope);
  return {
    name,
    index: scope === 'both' ? `${ES_INDEX_ALIAS},${PROJECTS_INDEX_ALIAS}` : String(scope === 'projects' ? PROJECTS_INDEX_ALIAS : ES_INDEX_ALIAS),
    exec: () =>
      runViaBuilder(() =>
        queryESMapMarkers({ bounds, seedKey: `profile-${name}`, must, filters, scope, sort } as any)
      ),
  };
}

function fillShape(name: string, bounds: any, scope: string, sort: string, size: number): Shape {
  const { must, filters } = buildFilters({ bounds, scope, sort }, scope);
  return {
    name,
    // resolveTileIndexes routes no-text fills to the unified tile index.
    index: TILES_INDEX_ALIAS,
    exec: () =>
      runViaBuilder(() =>
        querySortFillForBounds({ must, filters, scope, sort, size, timeoutMs: 4000 } as any)
      ),
  };
}

function pillsShape(name: string, bounds: any, scope: string): Shape {
  const { filters } = buildFilters({ bounds, scope, sort: 'newest' }, scope);
  return {
    name,
    index: scope === 'both' ? `${ES_INDEX_ALIAS},${PROJECTS_INDEX_ALIAS}` : String(scope === 'projects' ? PROJECTS_INDEX_ALIAS : ES_INDEX_ALIAS),
    exec: () => runViaBuilder(() => queryESProjectGroups({ ...filters, bounds }, scope)),
  };
}

// Runtime quantile aggregation, same shape as map-data's runAgg (country box).
function quantileShape(name: string, bounds: any, scope: string): Shape {
  const index = scope === 'projects' ? PROJECTS_INDEX_ALIAS : scope === 'properties' ? ES_INDEX_ALIAS : [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS];
  const q = {
    index,
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { term: { status: 'available' } },
          { geo_bounding_box: { location: { top_left: { lat: bounds.maxLat, lon: bounds.minLng }, bottom_right: { lat: bounds.minLat, lon: bounds.maxLng } } } },
        ],
      },
    },
    aggs: { p: { percentiles: { field: 'created_at', percents: [50, 90] } } },
  };
  return { name, index: String(q.index), exec: () => runProfiled(q, { request_cache: false, allow_partial_search_results: true, timeout: '2000ms' }) };
}

function buildShapes(): Shape[] {
  const shapes: Shape[] = [];
  const split = process.env.SPLIT_COUNTS !== '0';
  const native = process.env.NATIVE_COUNTS !== '0';

  shapes.push(listShape(`list_both_newest${split ? '' : native ? '_inline_native' : '_inline_counters'}`, DELHI, { scope: 'both', sort: 'newest' }));
  shapes.push(listShape('list_both_price_desc', DELHI, { scope: 'both', sort: 'price_desc' }));
  shapes.push(listShape('list_props_newest', DELHI, { scope: 'properties', sort: 'newest' }));
  if (split) {
    process.env.SPLIT_COUNTS = '0';
    shapes.push(listShape('list_both_newest_INLINE_NATIVE', DELHI, { scope: 'both', sort: 'newest' }));
    process.env.NATIVE_COUNTS = '0';
    shapes.push(listShape('list_both_newest_INLINE_COUNTERS', DELHI, { scope: 'both', sort: 'newest' }));
    delete process.env.SPLIT_COUNTS;
    delete process.env.NATIVE_COUNTS;
  }

  shapes.push(countShape('count_both', DELHI, 'both'));
  shapes.push(countShape('count_props', DELHI, 'properties'));

  shapes.push(tileShape('tile_city_delhi_z11', DELHI, 11, 'both', 'newest'));
  shapes.push(tileShape('tile_city_dubai_z10', DUBAI, 10, 'both', 'price_desc'));
  shapes.push(tileShape('tile_country_z4', COUNTRY, 4, 'both', 'newest'));

  shapes.push(fillShape('fill_viewport_500', DELHI, 'both', 'newest', 500));
  shapes.push(legacyMarkerShape('legacy_random_500', DELHI, 'both', 'newest'));
  shapes.push(pillsShape('pills_by_project', DELHI, 'both'));
  shapes.push(quantileShape('quantile_created_country', COUNTRY, 'both'));
  return shapes;
}

// ---- run -------------------------------------------------------------------------

async function main() {
  if (process.env.ROUTE_TIMING) delete process.env.ROUTE_TIMING;
  console.log(`# profile corpus=${LABEL} runs=${RUNS} (warmup ${WARMUP})`);
  console.log(`# indices: props=${ES_INDEX_ALIAS} projects=${PROJECTS_INDEX_ALIAS} tiles=${TILES_INDEX_ALIAS}`);
  const shapes = buildShapes();
  const results: any = { label: LABEL, runs: RUNS, indices: { props: ES_INDEX_ALIAS, projects: PROJECTS_INDEX_ALIAS, tiles: TILES_INDEX_ALIAS }, shapes: {} };

  for (const shape of shapes) {
    const runs: ProfiledRun[] = [];
    const parsed: any[] = [];
    const shardBefore = SHARD_STATS ? await shardQueryTotals(shape.index) : {};
    for (let i = 0; i < RUNS + WARMUP; i++) {
      let run: ProfiledRun;
      try {
        run = await shape.exec();
      } catch (e: any) {
        console.log(`\n## ${shape.name}\nFAILED: ${e?.meta?.body ? JSON.stringify(e.meta.body).slice(0, 300) : e?.message}`);
        results.shapes[shape.name] = { error: String(e?.message || e) };
        break;
      }
      if (i < WARMUP) continue;
      runs.push(run);
      parsed.push(parseProfile(run.profile));
    }
    if (!parsed.length) continue;

    const med = {
      wallMs: median(runs.map((r) => r.wallMs)),
      tookMs: median(runs.map((r) => r.tookMs)),
      shardCount: parsed[0].shardCount,
      rewriteMs: median(parsed.map((p) => p.rewriteMs)),
      queryMs: median(parsed.map((p) => p.queryMs)),
      collectorMs: median(parsed.map((p) => p.collectorMs)),
      fetchMs: median(parsed.map((p) => p.fetchMs)),
      totalShardCpuMs: median(parsed.map((p) => p.totalShardCpuMs)),
      queryClauses: medianMaps(parsed.map((p) => p.queryClauses)),
      queryLeaves: medianMaps(parsed.map((p) => p.queryLeaves)),
      collectors: medianMaps(parsed.map((p) => p.collectors)),
      collectorChildren: medianMaps(parsed.map((p) => p.collectorChildren)),
      aggs: medianMaps(parsed.map((p) => p.aggs)),
    };
    let shardDelta: any = null;
    if (SHARD_STATS) {
      const shardAfter = await shardQueryTotals(shape.index);
      const perShard: Record<string, number> = {};
      for (const k of Object.keys(shardAfter)) perShard[k] = shardAfter[k] - (shardBefore[k] || 0);
      const vals = Object.values(perShard);
      shardDelta = {
        total: vals.reduce((a, b) => a + b, 0),
        min: vals.length ? Math.min(...vals) : 0,
        max: vals.length ? Math.max(...vals) : 0,
        avg: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : 0,
        perShard,
      };
    }
    results.shapes[shape.name] = { index: shape.index, ...med, shardDelta };

    const pct = (v: number) => med.totalShardCpuMs > 0 ? `${((v / med.totalShardCpuMs) * 100).toFixed(1)}%` : '-';
    console.log(`\n## ${shape.name}  [${shape.index}]`);
    console.log(`wall=${med.wallMs.toFixed(1)}ms took=${med.tookMs.toFixed(1)}ms shards=${med.shardCount} shardCPU=${med.totalShardCpuMs.toFixed(1)}ms`);
    if (shardDelta) console.log(`  shardQueries(${RUNS + WARMUP} runs): total=${shardDelta.total} min=${shardDelta.min} avg=${shardDelta.avg} max=${shardDelta.max}`);
    console.log(`  rewrite ${med.rewriteMs.toFixed(1)}ms (${pct(med.rewriteMs)}) | query ${med.queryMs.toFixed(1)}ms (${pct(med.queryMs)}) | collect ${med.collectorMs.toFixed(1)}ms (${pct(med.collectorMs)}) | fetch ${med.fetchMs.toFixed(1)}ms (${pct(med.fetchMs)})`);
    const fmt = (m: Record<string, number>) =>
      Object.entries(m).slice(0, 6).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
    console.log(`  clauses: ${fmt(med.queryClauses)}`);
    console.log(`  leaf: ${fmt(med.queryLeaves)}`);
    console.log(`  collectors: ${fmt(med.collectors)}`);
    if (Object.keys(med.collectorChildren).length) console.log(`  agg-children: ${fmt(med.collectorChildren)}`);
    if (Object.keys(med.aggs).length) console.log(`  aggs: ${fmt(med.aggs)}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/profile-${LABEL}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n# wrote ${file}`);
}

main().catch((e) => {
  console.error(e?.meta?.body || e);
  process.exit(1);
});
