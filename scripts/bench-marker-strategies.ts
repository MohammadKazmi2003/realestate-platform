// Marker-strategy benchmark for the /browse tile path.
//
// Compares, on the same population/viewport and with request_cache OFF (so
// shard CPU is real work, not cache hits):
//   1. app_adaptive      — the shipped queryTileMarkersForBounds (geotile_grid
//                          + top_hits, adaptive precision, up to 2 attempts)
//   2. fixed_top_hits    — the shipped agg shape at precisionForZoom(zoom)
//   3. sampler_10k      — `sampler` (first N matching docs) wrapping the grid
//   4. random_sampler_p — `random_sampler` probability p wrapping the grid
//   5. counts_only      — grid with no top_hits (density cells only)
//   6. counts_plus_fill — counts_only + the shipped sort-aware fill (500)
//   7. fanout_parallel  — shipped covering tiles in parallel + shipped merge
//   8. legacy_random    — legacy function_score random_score 500 (fallback)
//
// Accuracy: cell-rank overlap and marker-id overlap vs fixed_top_hits.
//
// Usage:
//   ES_TILES_INDEX=bench_tile_5m ES_PROPERTIES_INDEX=bench_props_5m \
//   ES_PROJECTS_INDEX=bench_projects_5m npx tsx scripts/bench-marker-strategies.ts \
//     --label=5m --runs=7 [--conc=8 --conc-n=32]
import { writeFileSync, mkdirSync } from 'fs';
import { getElasticsearchClient, TILES_INDEX_ALIAS } from '@/lib/elasticsearch';
import { buildFilters, queryESMapMarkers } from '@/lib/esQueryBuilder';
import {
  buildTileAggQuery,
  queryTileMarkersForBounds,
  querySortFillForBounds,
} from '@/lib/esTileMarkers';
import { mergeTileMarkers, stripInternalMarkerFields } from '@/lib/tileMerge';
import { viewportCoveringTiles, tileToBounds, precisionForZoom, maxPrecisionForZoom } from '@/lib/mapTiles';
import { mapWithConcurrency } from '@/lib/concurrency';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const LABEL = String(args.label || 'x');
const RUNS = Number(args.runs || 7);
const WARMUP = 2;
const CONC = Number(args.conc || 0);
const CONC_N = Number(args['conc-n'] || 32);
const DENSITY = Number(args['sampler-size'] || 10000);
const RSPROB = Number(args['rs-prob'] || 0.1);
const OUT_DIR = 'bench-results';

const es: any = getElasticsearchClient();

// `precision` mirrors what the shipped adaptive loop actually settles on for
// that viewport (read from tile adaptive logs), so manual variants are
// apples-to-apples with app_adaptive and are not stuck at a single cell.
const VIEWPORTS: { name: string; bounds: any; zoom: number; precision: number }[] = [
  { name: 'delhi_z11', bounds: { minLat: 28.30, maxLat: 28.80, minLng: 76.90, maxLng: 77.50 }, zoom: 11, precision: 9 },
  { name: 'dubai_z10', bounds: { minLat: 24.95, maxLat: 25.45, minLng: 55.05, maxLng: 55.55 }, zoom: 10, precision: 6 },
  { name: 'country_z4', bounds: { minLat: 8.0, maxLat: 35.0, minLng: 54.0, maxLng: 97.0 }, zoom: 4, precision: 6 },
];

// ---- profile parsing (compact copy of the profile harness) ----------------------

function leafAttribution(node: any, out: Record<string, number>) {
  if (!node || typeof node !== 'object') return;
  const wrappers = new Set(['BooleanQuery', 'ConstantScoreQuery', 'BoostingQuery', 'DisjunctionMaxQuery', 'FunctionScoreQuery', 'BoostQuery']);
  const type = node.type || 'unknown';
  if (wrappers.has(type) && Array.isArray(node.children) && node.children.length > 0) {
    for (const c of node.children) leafAttribution(c.query ?? c, out);
    return;
  }
  out[type] = (out[type] || 0) + (node.time_in_nanos || 0);
}

function parseProfile(profile: any) {
  let query = 0, collect = 0, fetch = 0, rewrite = 0;
  const aggs: Record<string, number> = {};
  const collectors: Record<string, number> = {};
  for (const s of profile?.shards || []) {
    for (const srch of s.searches || []) {
      rewrite += srch.rewrite_time || 0;
      for (const q of srch.query || []) query += q.time_in_nanos || 0;
      for (const c of srch.collector || []) {
        collect += c.time_in_nanos || 0;
        collectors[c.name || '?'] = (collectors[c.name || '?'] || 0) + (c.time_in_nanos || 0);
        const walk = (n: any) => {
          for (const ch of n.children || []) {
            const nm = ch.name || '?';
            aggs[nm] = (aggs[nm] || 0) + (ch.time_in_nanos || 0);
            walk(ch);
          }
        };
        walk(c);
      }
    }
    for (const a of s.aggregations || []) {
      aggs[a.type || '?'] = (aggs[a.type || '?'] || 0) + (a.time_in_nanos || 0);
    }
    if (s.fetch) fetch += s.fetch.time_in_nanos || 0;
  }
  return { rewriteMs: rewrite / 1e6, queryMs: query / 1e6, collectMs: collect / 1e6, fetchMs: fetch / 1e6, aggsMs: Object.fromEntries(Object.entries(aggs).map(([k, v]) => [k, v / 1e6])), collectorsMs: Object.fromEntries(Object.entries(collectors).map(([k, v]) => [k, v / 1e6])) };
}

type StrategyRun = {
  wallMs: number; tookMs: number; profile: any;
  cells?: Record<string, number>; markers?: string[]; cellTotal?: number;
  extra?: any;
};

async function runProfiled(query: any): Promise<StrategyRun> {
  const t0 = performance.now();
  // Index injection: manual shapes are bodies only; without an explicit index
  // ES would query EVERY index in the cluster (the first harness bug).
  const res: any = await es.search({ index: TILES_INDEX_ALIAS, ...query, profile: true, request_cache: false });
  const wallMs = performance.now() - t0;
  const out: StrategyRun = { wallMs, tookMs: res.took, profile: res.profile };
  return out;
}

async function searchNoProfile(query: any): Promise<any> {
  return es.search({ index: TILES_INDEX_ALIAS, ...query, request_cache: false });
}

function cellsFromRes(res: any, path: string[]): { cells: Record<string, number>; markers: string[] } {
  let agg: any = res.aggregations;
  for (const p of path) agg = agg?.[p];
  const cells: Record<string, number> = {};
  const markers: string[] = [];
  for (const b of agg?.buckets || []) {
    cells[b.key] = b.doc_count;
    const rep = b.top?.hits?.hits?.[0]?._source;
    if (rep) markers.push(String(rep.id));
  }
  return { cells, markers };
}

// ---- strategy builders -----------------------------------------------------------

function pop(viewport: any, sort = 'newest') {
  const { must, filters } = buildFilters(
    { bounds: viewport.bounds, scope: 'both', sort },
    'both'
  );
  return { must, filters };
}

function gridAgg(viewport: any, must: any[], filters: any[], opts: { topHits?: boolean; precision?: number; sort?: string; size?: number; shardSize?: number } = {}) {
  const precision = Math.min(
    opts.precision ?? viewport.precision ?? precisionForZoom(viewport.zoom),
    maxPrecisionForZoom(viewport.zoom),
    12
  );
  const tileBox = {
    top_left: { lat: viewport.bounds.maxLat, lon: viewport.bounds.minLng },
    bottom_right: { lat: viewport.bounds.minLat, lon: viewport.bounds.maxLng },
  };
  const tiles: any = {
    geotile_grid: {
      field: 'location',
      precision,
      size: opts.size ?? 1000,
      shard_size: opts.shardSize ?? 1500,
      bounds: tileBox,
    },
  };
  if (opts.topHits !== false) {
    tiles.aggs = {
      top: {
        top_hits: {
          size: 1,
          sort: [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }],
          // id only: keeps aggregation CPU measurable while allowing marker-id
          // accuracy comparison (full preview source is measured separately).
          _source: ['id'],
        },
      },
    };
  }
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { must: must.length ? must : [{ match_all: {} }], filter: [...filters, { geo_bounding_box: { location: tileBox } }] } },
    aggs: { tiles },
    _source: false,
  };
}

function samplerGrid(viewport: any, must: any[], filters: any[], kind: 'sampler' | 'random_sampler') {
  const base = gridAgg(viewport, must, filters, { topHits: true });
  const tiles = base.aggs.tiles;
  return {
    size: 0,
    track_total_hits: false,
    query: base.query,
    aggs: {
      sample: {
        [kind]: kind === 'sampler' ? { shard_size: DENSITY } : { probability: RSPROB, seed: 42 },
        aggs: { tiles },
      },
    },
    _source: false,
  };
}

async function runStrategy(name: string, viewport: any, fn: () => Promise<StrategyRun>): Promise<StrategyRun & { name: string }> {
  const runs: StrategyRun[] = [];
  for (let i = 0; i < RUNS + WARMUP; i++) {
    try {
      const r = await fn();
      if (i >= WARMUP) runs.push(r);
    } catch (e: any) {
      return { name, wallMs: NaN, tookMs: NaN, profile: null, extra: { error: String(e?.meta?.body ? JSON.stringify(e.meta.body).slice(0, 200) : e?.message || e) } };
    }
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const parsed = runs.map((r) => parseProfile(r.profile));
  const pick = (k: keyof ReturnType<typeof parseProfile>) => med(parsed.map((p) => p[k] as number));
  const aggKeys = new Set(parsed.flatMap((p) => Object.keys(p.aggsMs)));
  const medAggs: Record<string, number> = {};
  for (const k of aggKeys) medAggs[k] = med(parsed.map((p) => p.aggsMs[k] || 0));
  return {
    name,
    wallMs: med(runs.map((r) => r.wallMs)),
    tookMs: med(runs.map((r) => r.tookMs)),
    profile: null,
    cells: runs[0].cells,
    markers: runs[0].markers,
    cellTotal: runs[0].cellTotal,
    extra: {
      runs: runs.length,
      rewriteMs: pick('rewriteMs'),
      queryMs: pick('queryMs'),
      collectMs: pick('collectMs'),
      fetchMs: pick('fetchMs'),
      aggsMs: Object.fromEntries(Object.entries(medAggs).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1])),
      cells: runs[0].cells ? Object.keys(runs[0].cells).length : undefined,
      cellDocs: runs[0].cells ? Object.values(runs[0].cells).reduce((a, b) => a + b, 0) : undefined,
      markerCount: runs[0].markers?.length,
    },
  };
}

function overlap(a?: string[], b?: string[]) {
  if (!a || !b || !a.length || !b.length) return null;
  const sb = new Set(b);
  return a.filter((x) => sb.has(x)).length / a.length;
}

function topCellOverlap(a?: Record<string, number>, b?: Record<string, number>) {
  if (!a || !b) return null;
  const top = (m: Record<string, number>, n: number) => Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => k);
  const ta = new Set(top(a, 5));
  const tb = top(b, 5);
  if (!tb.length) return null;
  return tb.filter((k) => ta.has(k)).length / tb.length;
}

// ---- main ------------------------------------------------------------------------

async function main() {
  console.log(`# marker strategies corpus=${LABEL} tileIndex=${TILES_INDEX_ALIAS} runs=${RUNS}`);
  const results: any = { label: LABEL, tileIndex: TILES_INDEX_ALIAS, runs: RUNS, viewports: {} };

  for (const vp of VIEWPORTS) {
    const { must, filters } = pop(vp);
    const cellsPathAll = ['tiles'];
    const cellsPathSample = ['sample', 'tiles'];

    const SKIP = new Set(String(args.skip || '').split(',').filter(Boolean));
    const strategiesAll: { key: string; run: () => Promise<StrategyRun> }[] = [
      {
        key: 'app_adaptive',
        run: async () => {
          const orig = es.search;
          let profile: any = null; let took = 0;
          es.search = async (q: any, ...rest: any[]) => { const res = await orig.call(es, { ...q, profile: true, request_cache: false }, ...rest); profile = res.profile; took = res.took; return res; };
          const t0 = performance.now();
          try { await queryTileMarkersForBounds({ tileBounds: vp.bounds, must, filters, scope: 'both', sort: 'newest', zoom: vp.zoom, timeoutMs: 4000 } as any); } finally { es.search = orig; }
          return { wallMs: performance.now() - t0, tookMs: took, profile };
        },
      },
      {
        key: 'fixed_top_hits',
        run: async () => {
          const q = gridAgg(vp, must, filters, { topHits: true });
          const r = await runProfiled(q);
          const res: any = await searchNoProfile(q);
          const c = cellsFromRes(res, cellsPathAll);
          return { ...r, ...c };
        },
      },
      {
        key: 'grid_size_200',
        run: async () => {
          const q = gridAgg(vp, must, filters, { topHits: true, size: 200, shardSize: 300 });
          const r = await runProfiled(q);
          const res: any = await searchNoProfile(q);
          const c = cellsFromRes(res, cellsPathAll);
          return { ...r, ...c };
        },
      },
      {
        key: 'precision_minus1',
        run: async () => {
          const q = gridAgg(vp, must, filters, { topHits: true, precision: Math.max(1, vp.precision - 1) });
          const r = await runProfiled(q);
          const res: any = await searchNoProfile(q);
          const c = cellsFromRes(res, cellsPathAll);
          return { ...r, ...c };
        },
      },
      {
        key: 'sampler_10k',
        run: async () => {
          const q = samplerGrid(vp, must, filters, 'sampler');
          const r = await runProfiled(q);
          const res: any = await searchNoProfile(q);
          const c = cellsFromRes(res, cellsPathSample);
          return { ...r, ...c, cellTotal: res.aggregations?.sample?.doc_count };
        },
      },
      {
        key: 'random_sampler',
        run: async () => {
          const q = samplerGrid(vp, must, filters, 'random_sampler');
          const r = await runProfiled(q);
          const res: any = await searchNoProfile(q);
          const c = cellsFromRes(res, cellsPathSample);
          return { ...r, ...c, cellTotal: res.aggregations?.sample?.doc_count };
        },
      },
      {
        key: 'counts_only',
        run: async () => {
          const q = gridAgg(vp, must, filters, { topHits: false });
          const r = await runProfiled(q);
          const res: any = await searchNoProfile(q);
          const c = cellsFromRes(res, cellsPathAll);
          return { ...r, ...c };
        },
      },
      {
        key: 'counts_plus_fill',
        run: async () => {
          const q = gridAgg(vp, must, filters, { topHits: false });
          const t0 = performance.now();
          const r = await runProfiled(q);
          const fill = await querySortFillForBounds({ must, filters, scope: 'both', sort: 'newest', size: 500, timeoutMs: 4000 });
          const wall = performance.now() - t0;
          return { ...r, wallMs: wall, extraFillMarkers: fill.markers.length };
        },
      },
      {
        key: 'fanout_parallel',
        run: async () => {
          const tiles = viewportCoveringTiles(vp.bounds, vp.zoom);
          const t0 = performance.now();
          const outs: any[] = [];
          // Authentic per-tile path: shipped adaptive query per covering tile.
          await mapWithConcurrency(tiles, Math.min(6, tiles.length), async (t: any) => {
            const tb = tileToBounds(t.z, t.x, t.y);
            const r: any = await queryTileMarkersForBounds({ tileBounds: tb, must, filters, scope: 'both', sort: 'newest', zoom: vp.zoom, timeoutMs: 4000 } as any);
            outs.push({ markers: r?.markers || [], cells: r?.cells || [], took: r?.took || 0 });
          });
          const merged = stripInternalMarkerFields(mergeTileMarkers(outs, vp.bounds, 'newest', 500));
          return { wallMs: performance.now() - t0, tookMs: Math.max(...outs.map((o) => o.took || 0)), profile: null, markers: merged.map((m: any) => String(m.id)), extra: { tiles: tiles.length, perTileTook: outs.map((o) => o.took) } };
        },
      },
      {
        key: 'legacy_random',
        run: async () => {
          const orig = es.search;
          let profile: any = null; let took = 0;
          es.search = async (q: any, ...rest: any[]) => { const res = await orig.call(es, { ...q, profile: true, request_cache: false }, ...rest); profile = res.profile; took = res.took; return res; };
          const t0 = performance.now();
          let markers: string[] = [];
          try {
            const out: any = await queryESMapMarkers({ bounds: vp.bounds, seedKey: `marker-bench-${vnSafe(vp.name)}`, must, filters, scope: 'both', sort: 'newest' } as any);
            markers = (out || []).map((m: any) => String(m.id));
          } finally { es.search = orig; }
          return { wallMs: performance.now() - t0, tookMs: took, profile, markers };
        },
      },
    ];

    const vpResults: any = {};
    const fixed = strategiesAll.find((s) => s.key === 'fixed_top_hits')!;
    const baseline = await runStrategy(fixed.key, vp, fixed.run);
    vpResults[fixed.key] = { ...baseline, extra: { ...baseline.extra, topCellOverlap: 1, markerOverlap: 1 } };
    console.log(`\n## ${vp.name}  [${TILES_INDEX_ALIAS}]`);
    logRow(baseline, baseline);

    for (const s of strategiesAll) {
      if (s.key === 'fixed_top_hits' || SKIP.has(s.key)) continue;
      const r = await runStrategy(s.key, vp, s.run);
      r.extra = {
        ...r.extra,
        topCellOverlap: topCellOverlap(baseline.cells, r.cells),
        markerOverlap: overlap(baseline.markers, r.markers),
      };
      vpResults[s.key] = r;
      logRow(r, baseline);
    }
    results.viewports[vp.name] = vpResults;
  }

  if (CONC > 0) {
    results.concurrency = {};
    for (const vp of VIEWPORTS.slice(0, 2)) {
      const { must, filters } = pop(vp);
      for (const [key, q] of [
        ['fixed_top_hits', gridAgg(vp, must, filters, { topHits: true })],
        ['sampler_10k', samplerGrid(vp, must, filters, 'sampler')],
        ['random_sampler', samplerGrid(vp, must, filters, 'random_sampler')],
        ['counts_only', gridAgg(vp, must, filters, { topHits: false })],
      ] as any[]) {
        const walls: number[] = [];
        let next = 0; let errs = 0;
        const t0 = performance.now();
        await Promise.all(Array.from({ length: CONC }, async () => {
          for (;;) {
            const i = next++; if (i >= CONC_N) return;
            const s = performance.now();
            try { await searchNoProfile(q); } catch { errs++; }
            walls.push(performance.now() - s);
          }
        }));
        const sec = (performance.now() - t0) / 1000;
        walls.sort((a, b) => a - b);
        const p = (n: number) => walls[Math.min(walls.length - 1, Math.ceil((n / 100) * walls.length) - 1)] || 0;
        results.concurrency[`${vp.name}:${key}`] = { conc: CONC, n: CONC_N, qps: Number((CONC_N / sec).toFixed(1)), p50: Math.round(p(50)), p95: Math.round(p(95)), p99: Math.round(p(99)), errs };
      }
    }
    console.log('\n## concurrency');
    for (const [k, v] of Object.entries<any>(results.concurrency)) console.log(`  ${k.padEnd(28)} qps=${v.qps} p50=${v.p50} p95=${v.p95} p99=${v.p99} errs=${v.errs}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/marker-strategies-${LABEL}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n# wrote ${file}`);
}

function vnSafe(s: string) { return s.replace(/[^a-z0-9_]/gi, '-'); }

function logRow(r: any, baseline: any) {
  const e = r.extra || {};
  const cpu = (e.queryMs || 0) + (e.collectMs || 0) + (e.fetchMs || 0) + (e.rewriteMs || 0);
  const aggTop = Object.entries<any>(e.aggsMs || {}).slice(0, 2).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' ');
  const ov = e.topCellOverlap == null ? '-' : `${(e.topCellOverlap * 100).toFixed(0)}%`;
  const mo = e.markerOverlap == null ? '-' : `${(e.markerOverlap * 100).toFixed(0)}%`;
  console.log(
    `  ${r.name.padEnd(18)} wall=${fmt(r.wallMs)} took=${fmt(r.tookMs)} cpu=${fmt(e.error ? NaN : cpu)} cells=${e.cells ?? '-'} docs=${e.cellDocs ?? '-'} reps=${e.markerCount ?? e.extraFillMarkers ?? '-'} ` +
    `top5cell=${ov} markerOv=${mo} | q=${fmt(e.queryMs)} col=${fmt(e.collectMs)} f=${fmt(e.fetchMs)} ${aggTop}${e.tiles ? ` tiles=${e.tiles}` : ''}${e.error ? ' ERR=' + e.error : ''}`
  );
}
function fmt(v: any) { return v == null || Number.isNaN(v) ? '  -  ' : v.toFixed(1); }

main().catch((e) => { console.error(e?.meta?.body || e); process.exit(1); });
