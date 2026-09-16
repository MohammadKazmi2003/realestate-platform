// Tile MAP query: size:0 geotile_grid + top_hits:1 + percentiles.
// Additive P3/P4 — does NOT touch esQueryBuilder random_score path.
// All filters in bool.filter (no scoring), track_total_hits:false.
// top_hits carries full marker _source so hover/click stay fetch-free
// (top_metrics supports only numeric/keyword and would break previews).
// Adaptive precision (below) keeps clustered cities from collapsing into a
// handful of coarse cells at low zoom.

import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { precisionForZoom } from '@/lib/mapTiles';
import { tileToBounds } from '@/lib/mapTiles';

// Re-export marker mapping shape parity: server maps buckets -> same marker objects
// as queryESMapMarkers (id, entity_type, lat/lon, price, title, image, specs...).
// MARKER_SOURCE_FIELDS subset kept identical for hover/click fetch-free contract.
const TILE_TOP_METRICS_FIELDS = [
  'id', 'entity_type', 'location',
  'price', 'sort_price', 'low_price', 'high_price', 'title', 'name',
  'image_url', 'primary_image', 'bhk_type', 'bathrooms', 'balconies',
  'furnishing_status', 'listing_purpose', 'property_type',
  'area_sqft', 'area_unit', 'location_text', 'created_at',
  'developer_name', 'project_name',
  'construction_phase', 'construction_progress_percent', 'delivery_date',
  'amenities', 'amenities_total', 'bedrooms_list', 'unit_count',
  'payment_plan_summary', 'image_count',
];

function sortForTopMetrics(sort: string, scope: string): any[] {
  // Same semantics as buildSortClause inner, without _score secondary
  // (filter-only MAP has no scoring). missing:_last indexed, no scripts.
  if (scope === 'both') {
    if (sort === 'price_asc') return [{ sort_price: { order: 'asc', missing: '_last' } }, { id: { order: 'asc' } }];
    if (sort === 'price_desc') return [{ sort_price: { order: 'desc', missing: '_last' } }, { id: { order: 'asc' } }];
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }];
    // beds/baths/sqft/lot use property scalars; project docs sink via
    // missing:_last (documented mixed-scope semantics, mirrors list path).
    // popular has no deterministic field here — documented newest fallback.
    // unmapped_type is required: without it ES fails the shard with
    // "No mapping found ... in order to sort on" (dynamic:false, the projects
    // index has no such field) and the whole multi-index query returns 0.
    if (sort === 'beds') return [{ bedrooms: { order: 'desc', missing: '_last', unmapped_type: 'integer' } }, { id: { order: 'asc' } }];
    if (sort === 'baths') return [{ bathrooms: { order: 'desc', missing: '_last', unmapped_type: 'integer' } }, { id: { order: 'asc' } }];
    if (sort === 'sqft' || sort === 'lot') return [{ area_sqft: { order: 'desc', missing: '_last', unmapped_type: 'float' } }, { id: { order: 'asc' } }];
    return [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }];
  }
  if (scope === 'projects') {
    if (sort === 'price_asc') return [{ low_price: { order: 'asc', missing: '_last' } }, { id: { order: 'asc' } }];
    if (sort === 'price_desc') return [{ low_price: { order: 'desc', missing: '_last' } }, { id: { order: 'asc' } }];
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }];
    if (sort === 'beds') return [{ bedrooms_list: { order: 'desc', mode: 'min', missing: '_last' } }, { id: { order: 'asc' } }];
    return [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }];
  }
  if (sort === 'price_asc') return [{ price: { order: 'asc', missing: '_last' } }, { id: { order: 'asc' } }];
  if (sort === 'price_desc') return [{ price: { order: 'desc', missing: '_last' } }, { id: { order: 'asc' } }];
  if (sort === 'newest') return [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }];
  if (sort === 'beds') return [{ bedrooms: { order: 'desc', missing: '_last' } }, { id: { order: 'asc' } }];
  if (sort === 'baths') return [{ bathrooms: { order: 'desc', missing: '_last' } }, { id: { order: 'asc' } }];
  if (sort === 'sqft' || sort === 'lot') return [{ area_sqft: { order: 'desc', missing: '_last' } }, { id: { order: 'asc' } }];
  return [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }];
}

function percentileFieldForSort(sort: string, scope: string): string | null {
  if (sort === 'price_asc' || sort === 'price_desc') {
    if (scope === 'projects') return 'low_price';
    if (scope === 'both') return 'sort_price';
    return 'price';
  }
  if (sort === 'newest') return 'created_at';
  // Quantile narrowing only where the field exists across the queried scope(s).
  // beds/baths/sqft exist on properties only — narrowing a both-scope query on
  // them would silently drop all projects, so both/projects use plain per-cell
  // top-1 (still sort-ordered). popular has no deterministic field at all.
  if (scope !== 'properties') return null;
  if (sort === 'beds') return 'bedrooms';
  if (sort === 'baths') return 'bathrooms';
  if (sort === 'sqft' || sort === 'lot') return 'area_sqft';
  return null;
}

export interface TileAggParams {
  tileBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  must: any[];
  filters: any[];
  scope: string;
  sort?: string;
  zoom: number;
  withPercentiles?: boolean;
  // Adaptive-precision override. When omitted, precisionForZoom(zoom) is used.
  // The fetcher below raises precision while occupied cells stay sparse so
  // clustered data (whole cities in one coarse cell) still spreads into
  // hundreds of dots instead of collapsing to a few lonely pins.
  precision?: number;
}

// Adaptive-precision tuning: target enough occupied cells for ~500-dot density.
// Coarse cells at low zoom collapse entire cities into 1 bucket (e.g. 1541 docs
// in 3 cells at precision 3) — 1-rep-per-cell then yields a near-empty map.
// Raising precision splits jittered/close coordinates into many cells; the
// size:1000 cap bounds worst-case cost at scale. Truly stacked points (identical
// coordinates) never split — those render as count badges via _cellCount.
const MIN_OCCUPIED_CELLS = 150;
const MAX_GRID_PRECISION = 12;
const PRECISION_STEP = 3;
const MAX_PRECISION_ATTEMPTS = 4;
// Below this many cells the growth ratio is noise (3→4 cells looks "flat"
// but finer precision still splits) — always refine until attempts/max cap.
const DIMINISHING_MIN_CELLS = 30;
const DIMINISHING_RATIO = 1.2;

export function buildTileAggQuery(p: TileAggParams): any {
  const precision = p.precision ?? precisionForZoom(p.zoom);
  // Tile bounds constrain aggregation (widen-only already applied upstream).
  const tileBox = {
    top_left: { lat: p.tileBounds.maxLat, lon: p.tileBounds.minLng },
    bottom_right: { lat: p.tileBounds.minLat, lon: p.tileBounds.maxLng },
  };
  const filters = [
    ...p.filters,
    { geo_bounding_box: { location: tileBox } },
  ];
  const sort = p.sort || 'newest';
  const topSort = sortForTopMetrics(sort, p.scope);
  const aggs: any = {
    tiles: {
      geotile_grid: {
        field: 'location',
        precision,
        size: 1000,
        shard_size: 5000,
        bounds: tileBox,
      },
      aggs: {
        // top_hits (not top_metrics): must return full marker _source
        // (text/geo/image fields) to preserve hover/click fetch-free contract.
        // top_metrics supports only numeric/keyword and would break previews.
        top: {
          top_hits: {
            size: 1,
            sort: topSort,
            _source: TILE_TOP_METRICS_FIELDS,
          },
        },
      },
    },
  };
  const pField = p.withPercentiles ? percentileFieldForSort(sort, p.scope) : null;
  if (pField && pField !== 'created_at') {
    aggs.p90 = { percentiles: { field: pField, percents: [50, 90] } };
  } else if (pField === 'created_at') {
    // created_at percentiles are epoch_millis — cheap TDigest, powers newest tiers.
    aggs.p90 = { percentiles: { field: pField, percents: [50, 90] } };
  }
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { must: p.must.length > 0 ? p.must : [{ match_all: {} }], filter: filters } },
    aggs,
    _source: false,
  };
}

const NEW_LISTING_DAYS = 14;

// Shared _source -> marker mapping (hover/click fetch-free contract).
// Cell context (grid key + bucket count) travels for density badges/heat;
// fill-query reps pass null (single listings, count 1).
function sourceToMarker(m: any, cellKey: string | null, docCount: number | null): any | null {
  const loc = (m as any).location || {};
  // location may be string "lat,lon" from top_metrics — normalize.
  let lat: number | null = null;
  let lon: number | null = null;
  if (loc && typeof loc.lat === 'number') { lat = loc.lat; lon = loc.lon ?? null; }
  else if (typeof loc === 'string') {
    const parts = loc.split(',').map((s) => Number(s.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite)) { lat = parts[0]; lon = parts[1]; }
  }
  if (lat == null || lon == null) return null;
  const isProject = (m as any).entity_type === 'project';
  const created = (m as any).created_at ? Date.parse((m as any).created_at) : NaN;
  const newCutoff = Date.now() - NEW_LISTING_DAYS * 24 * 3600 * 1000;
  const fullAmenities = Array.isArray((m as any).amenities) ? (m as any).amenities : [];
  return {
    id: (m as any).id,
    entity_type: (m as any).entity_type,
    lat, lon,
    price: isProject ? ((m as any).low_price || 0) : ((m as any).sort_price || (m as any).price || 0),
    low_price: (m as any).low_price ?? null,
    high_price: (m as any).high_price ?? null,
    title: (m as any).title || (m as any).name || '',
    image_url: (m as any).image_url || (m as any).primary_image || null,
    bhk_type: (m as any).bhk_type || null,
    bathrooms: (m as any).bathrooms ?? null,
    balconies: (m as any).balconies ?? null,
    furnishing_status: (m as any).furnishing_status || null,
    listing_purpose: (m as any).listing_purpose || null,
    property_type: (m as any).property_type || null,
    area_sqft: (m as any).area_sqft ?? null,
    area_unit: (m as any).area_unit || null,
    location_text: (m as any).location_text || null,
    is_new: Number.isFinite(created) ? created >= newCutoff : false,
    developer_name: (m as any).developer_name || null,
    project_name: (m as any).project_name || null,
    construction_phase: (m as any).construction_phase || null,
    construction_progress_percent: (m as any).construction_progress_percent ?? null,
    delivery_date: (m as any).delivery_date || null,
    amenities: fullAmenities.slice(0, 6),
    amenities_total: typeof (m as any).amenities_total === 'number' ? (m as any).amenities_total : fullAmenities.length,
    bedrooms_list: Array.isArray((m as any).bedrooms_list) ? (m as any).bedrooms_list : [],
    unit_count: (m as any).unit_count ?? null,
    payment_plan_summary: (m as any).payment_plan_summary || null,
    image_count: typeof (m as any).image_count === 'number' ? (m as any).image_count : null,
    _cellKey: cellKey,
    _cellCount: docCount,
  };
}

function mapTopMetricsToMarker(top: any, docCount: number, cellKey: string): any | null {
  // top_hits returns {hits:{hits:[{_source, sort}]}} per bucket.
  // (top_metrics path removed: geo/text fields unsupported, breaks hover/click.)
  const hit = top?.hits?.hits?.[0];
  // Back-compat: accept legacy top_metrics shape {top:[{metrics}]} if present.
  const m = hit?._source || top?.top?.[0]?.metrics;
  if (!m) return null;
  return sourceToMarker(m, cellKey, docCount);
}

function mapHitToMarker(source: any): any | null {
  if (!source) return null;
  return sourceToMarker(source, null, null);
}

export async function queryTileMarkersForBounds(opts: {
  tileBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  must: any[];
  filters: any[];
  scope: string;
  sort?: string;
  zoom: number;
  withPercentiles?: boolean;
  timeoutMs?: number;
}): Promise<{ markers: any[]; cells: { key: string; count: number }[]; took?: number; p90?: any; precisionUsed?: number }> {
  const es: any = getElasticsearchClient();
  const indexes =
    opts.scope === 'both'
      ? [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS]
      : opts.scope === 'projects'
        ? PROJECTS_INDEX_ALIAS
        : ES_INDEX_ALIAS;
  // Both: two sub-aggs (props + projects) merged by cell key to preserve mix
  // without forced quota. Single scope: one agg.
  const needsSplit = opts.scope === 'both';
  const runOne = async (index: string | string[], extraFilter?: any, precision?: number) => {
    const body = buildTileAggQuery({
      tileBounds: opts.tileBounds,
      must: opts.must,
      filters: extraFilter ? [...opts.filters, extraFilter] : opts.filters,
      scope: opts.scope,
      sort: opts.sort,
      zoom: opts.zoom,
      withPercentiles: opts.withPercentiles,
      precision,
    });
    const res: any = await es.search({
      index,
      ...body,
      request_cache: true,
      timeout: `${opts.timeoutMs || 4000}ms`,
      allow_partial_search_results: true,
    } as any);
    return res;
  };

  const basePrecision = precisionForZoom(opts.zoom);

  const fetchAtPrecision = async (precision: number) => {
    if (!needsSplit) {
      const res = await runOne(indexes, undefined, precision);
      const buckets = res?.aggregations?.tiles?.buckets || [];
      const markers: any[] = [];
      const cells: { key: string; count: number }[] = [];
      for (const b of buckets) {
        cells.push({ key: b.key, count: b.doc_count });
        const mk = mapTopMetricsToMarker(b.top, b.doc_count, b.key);
        if (mk) markers.push(mk);
      }
      return { markers, cells, took: res?.took, p90: res?.aggregations?.p90 };
    }

  // Both: props + projects in parallel (same msearch-equivalent, Promise.all fallback).
  // Winner per cell is chosen by the active sort value (not cands[0]), so an
  // expensive-project cell shows its project under price_desc, etc.
  const _sortName = opts.sort || 'newest';
  const _asc = _sortName === 'price_asc';
  const rankOf = (m: any): number => {
    if (_sortName === 'price_asc' || _sortName === 'price_desc') {
      return typeof m?.price === 'number' && Number.isFinite(m.price) ? m.price : (_asc ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    }
    if (_sortName === 'beds') {
      const b = m?.bhk_type;
      const n = typeof b === 'string' ? parseInt(b, 10) : (typeof b === 'number' ? b : NaN);
      return Number.isFinite(n) ? (n as number) : Number.NEGATIVE_INFINITY;
    }
    if (_sortName === 'baths') {
      const v = m?.bathrooms;
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
    }
    if (_sortName === 'sqft' || _sortName === 'lot') {
      const v = m?.area_sqft;
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
    }
    // newest + popular-fallback: recency rank.
    const t = m?.created_at ? Date.parse(m.created_at) : NaN;
    return Number.isFinite(t) ? (t as number) : Number.NEGATIVE_INFINITY;
  };
  const pickWinner = (cands: any[]) => {
    let best = cands[0];
    for (let i = 1; i < cands.length; i++) {
      const rv = rankOf(cands[i]);
      const bv = rankOf(best);
      if (rv === bv) {
        if (String(cands[i]?.id).localeCompare(String(best?.id)) < 0) best = cands[i];
      } else if (_asc ? rv < bv : rv > bv) {
        best = cands[i];
      }
    }
    return best;
  };
  const [propRes, projRes] = await Promise.all([
    runOne(ES_INDEX_ALIAS, undefined, precision).catch(() => null),
    runOne(PROJECTS_INDEX_ALIAS, undefined, precision).catch(() => null),
  ]);
    const byCell = new Map<string, { count: number; cands: any[] }>();
    const pushRes = (res: any) => {
      if (!res) return;
      for (const b of res?.aggregations?.tiles?.buckets || []) {
        const e = byCell.get(b.key) || { count: 0, cands: [] };
        e.count += b.doc_count || 0;
        const mk = mapTopMetricsToMarker(b.top, b.doc_count, b.key);
        if (mk) e.cands.push(mk);
        byCell.set(b.key, e);
      }
    };
    pushRes(propRes);
    pushRes(projRes);
    const markers: any[] = [];
    const cells: { key: string; count: number }[] = [];
  Array.from(byCell.entries()).forEach(([key, v]) => {
    cells.push({ key, count: v.count });
    // Sort-aware winner (not props-biased cands[0]).
    if (v.cands[0]) markers.push(pickWinner(v.cands));
  });
    // Sort cells by count desc for quota thinning downstream (stable).
    cells.sort((a, b) => b.count - a.count);
    const took = Math.max(propRes?.took || 0, projRes?.took || 0);
    return { markers, cells, took, p90: propRes?.aggregations?.p90 || projRes?.aggregations?.p90 };
  };

  // Adaptive precision: coarse grids collapse clustered cities into a handful
  // of cells (1 rep each = near-empty map). Step precision up while occupied
  // cells stay sparse. Stop on diminishing returns (stacked identical coords
  // never split) or attempt cap. Miss-path only; results are cached per tile.
  let precision = basePrecision;
  let out = await fetchAtPrecision(precision);
  let attempts = 1;
  while (
    out.cells.length < MIN_OCCUPIED_CELLS &&
    precision < MAX_GRID_PRECISION &&
    attempts < MAX_PRECISION_ATTEMPTS
  ) {
    const prevCells = out.cells.length;
    precision = Math.min(MAX_GRID_PRECISION, precision + PRECISION_STEP);
    try {
      out = await fetchAtPrecision(precision);
    } catch {
      break;
    }
    attempts += 1;
    // Diminishing returns: precision no longer splitting = truly stacked data.
    // Ignored at tiny counts where the ratio is noise (3→4 cells must refine).
    if (prevCells >= DIMINISHING_MIN_CELLS && out.cells.length <= Math.ceil(prevCells * DIMINISHING_RATIO)) break;
    if (out.cells.length >= MIN_OCCUPIED_CELLS) break;
  }
  return { ...out, precisionUsed: precision };
}

// Hybrid fill: one bounded sort-aware top-K over the viewport to top up tile
// reps toward ~500 when cells are sparse (stacked towers share few cells).
// Cheapest ES shape after match_all bbox: indexed sort only (no scoring, no
// aggs, no exact count, track_total_hits:false, fetch = deficit only).
// Runs on tile-miss path only; result merges into the markerKey payload.
export async function querySortFillForBounds(opts: {
  must: any[];
  filters: any[];
  scope: string;
  sort?: string;
  size: number;
  timeoutMs?: number;
}): Promise<{ markers: any[]; took?: number }> {
  const es: any = getElasticsearchClient();
  const indexes =
    opts.scope === 'both'
      ? [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS]
      : opts.scope === 'projects'
        ? PROJECTS_INDEX_ALIAS
        : ES_INDEX_ALIAS;
  const sort = opts.sort || 'newest';
  const res: any = await es.search({
    index: indexes,
    size: Math.max(1, Math.min(500, Math.round(opts.size))),
    track_total_hits: false,
    query: { bool: { must: opts.must.length > 0 ? opts.must : [{ match_all: {} }], filter: opts.filters } },
    sort: sortForTopMetrics(sort, opts.scope),
    _source: TILE_TOP_METRICS_FIELDS,
    request_cache: true,
    timeout: `${opts.timeoutMs || 4000}ms`,
    allow_partial_search_results: true,
  } as any);
  const markers: any[] = [];
  for (const hit of res?.hits?.hits || []) {
    const mk = mapHitToMarker(hit?._source);
    if (mk) markers.push(mk);
  }
  return { markers, took: res?.took };
}

// Top up tile reps toward target (500) with sort-ordered fill, deduped.
// Contract: total<=target returns every match (caller falls back to legacy for
// exactness); total>target returns ~target spread + ranked reps.
// Pure function — no ES calls (caller runs querySortFillForBounds).
export function fillMarkerDeficit(
  tileMarkers: any[],
  fillMarkers: any[],
  tileDocTotal: number,
  target = 500
): any[] {
  const want = Math.max(0, Math.min(target, tileDocTotal) - tileMarkers.length);
  if (want <= 0 || fillMarkers.length === 0) return tileMarkers;
  const seen = new Set(tileMarkers.map((m: any) => `${m?.entity_type || ''}:${m?.id}`));
  const fresh: any[] = [];
  for (const m of fillMarkers) {
    if (fresh.length >= want) break;
    const k = `${m?.entity_type || ''}:${m?.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(m);
  }
  return [...tileMarkers, ...fresh];
}

export { tileToBounds };
