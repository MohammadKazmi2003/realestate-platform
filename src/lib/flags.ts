// Central feature flags for tile/quantile rollout.
// All new behavior is flag-gated, default ON for final architecture.
// Set env to 0 to revert to legacy path instantly (no code revert).
// Traceable: env only, no direct CMD/DB changes.

function envOn(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const t = String(v).toLowerCase().trim();
  if (['1', 'true', 'on', 'yes'].includes(t)) return true;
  if (['0', 'false', 'off', 'no'].includes(t)) return false;
  return def;
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const flags = {
  // P1: cap LIST exact totals to 10K (badge shows 10K+ when gte).
  get listCap10K() { return envOn('LIST_CAP_10K', true); },
  get listTrackCap() { return envNum('LIST_TRACK_CAP', 10000); },
  // P2: exact badge totals from filter→value_count counter siblings on LIST
  // (cheap counters riding the matching-doc pass — exact at every scale).
  // Off restores legacy track_total_hits + by_entity_type badge path.
  get exactCountCounters() { return envOn('EXACT_COUNT_COUNTERS', true); },
  // P2: tile v5 keys + tiered TTLs.
  get tileCacheV5() { return envOn('TILE_CACHE_V5', true); },
  // P3: shadow grid query (log-only, never served).
  get tileShadow() { return envOn('TILE_SHADOW', true); },
  get tileShadowPct() {
    const v = envNum('TILE_SHADOW_PCT', 100);
    return Math.max(0, Math.min(100, v));
  },
  // P4: serve MAP from tiles (cutover). Legacy random_score kept as fallback.
  get mapTilesV1() { return envOn('MAP_TILES_V1', true); },
  // P5: quantile sort-aware range.
  get quantileFilter() { return envOn('QUANTILE_FILTER', true); },
  // P6: msearch split (LIST+TILEs in one RTT). Fallback to Promise.all.
  get msearchEnabled() { return envOn('MSEARCH_ENABLED', true); },
  // Scale-ready P0: lazy project pills (skip by_project agg on list path).
  // Client fetches /api/project-groups separately. Default ON.
  get lazyPills() { return envOn('LAZY_PILLS', true); },
  // Scale-ready P0: tile fan-out caps. Env-overridable without code change
  // so adding ES nodes/replicas scales linearly (bounded per-query work).
  get tileMaxAttempts() { return Math.max(1, Math.min(4, envNum('TILE_MAX_ATTEMPTS', 2))); },
  get tileShardSize() { return Math.max(500, Math.min(5000, envNum('TILE_SHARD_SIZE', 1500))); },
  get tileMaxPrecisionLowZoom() { return Math.max(4, Math.min(12, envNum('TILE_MAX_PRECISION_LOW_ZOOM', 6))); },
  get tileMaxTiles() { return Math.max(4, Math.min(12, envNum('TILE_MAX_TILES', 8))); },
  // Scale-ready: geohash routing (forward-compatible; ignored until indices
  // are created with routing). ON means queries send `routing` param.
  get geoRouting() { return envOn('GEO_ROUTING', true); },
  // Scale-ready: distributed singleflight via Redis SET NX (cross-instance
  // dedup). Falls back to in-process map when Redis is down.
  get distSingleflight() { return envOn('DIST_SINGLEFLIGHT', true); },
  // Observability only.
  get obsOnly() { return envOn('OBS_ONLY', false); },
};

// Sort buckets — one cache entry per ordering that changes tile reps.
// popular is relevance-scored (no deterministic tile ordering) so it shares
// the default/newest bucket (documented fallback). lot orders by area_sqft
// but keeps its own bucket so a future dedicated field won't collide.
export function sortBucket(sort?: string): string {
  if (
    sort === 'price_asc' || sort === 'price_desc' || sort === 'newest' ||
    sort === 'beds' || sort === 'baths' || sort === 'sqft' || sort === 'lot'
  ) return sort;
  return 'default';
}

export function sortHashForKey(sort?: string): string {
  return sortBucket(sort);
}
