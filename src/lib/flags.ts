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
