// Quantile helper: runtime percentiles per region x sort -> range filter.
// Query-time only, no precompute-every-combo. Thresholds cached 24h, tiles 60-300s.
// Falls back to no-range (Phase 4 behavior) on miss + terms-fallback for low-cardinality.
// Infra-free: first request needing thresholds computes one size:0 TDigest agg,
// concurrent requests coalesce via module singleflight, result cached 24h+jitter.
// Nightly cron is optional prewarm only — never required.

import { cacheGet, cacheSet } from '@/lib/redis';

// Module-level coalescing for quantile computes (must live here, not in a
// route module — otherwise each route file gets its own map).
const quantileInflight = new Map<string, Promise<QuantileThresholds | null>>();

async function quantileSingleflight(key: string, fn: () => Promise<QuantileThresholds | null>): Promise<QuantileThresholds | null> {
  const existing = quantileInflight.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => {
    if (quantileInflight.get(key) === promise) quantileInflight.delete(key);
  });
  quantileInflight.set(key, promise);
  return promise;
}

export interface QuantileThresholds {
  p50?: number;
  p90?: number;
  updatedAt: string;
  version: string;
}

function regionForBounds(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }): string {
  // Geohash-4-ish region: 1° grid, stable across pans. Widen-only grouping.
  const lat = Math.floor(((bounds.minLat + bounds.maxLat) / 2) * 1) / 1;
  const lon = Math.floor(((bounds.minLng + bounds.maxLng) / 2) * 1) / 1;
  return `${lat}:${lon}`;
}

function sortFieldForQuantile(sort: string | undefined, scope: string): { field: string; dir: 'asc' | 'desc' } | null {
  if (sort === 'price_asc') return { field: scope === 'projects' ? 'low_price' : scope === 'both' ? 'sort_price' : 'price', dir: 'asc' };
  if (sort === 'price_desc') return { field: scope === 'projects' ? 'low_price' : scope === 'both' ? 'sort_price' : 'price', dir: 'desc' };
  if (sort === 'newest') return { field: 'created_at', dir: 'desc' };
  // Quantile narrowing only where the field exists across the queried scope(s).
  // beds/baths/sqft exist on properties only — narrowing a both-scope query on
  // them would silently drop all projects. properties-scope sorts narrow;
  // both/projects use plain per-cell top-1 (still sort-ordered). popular has
  // no deterministic field (documented newest fallback on map).
  if (scope === 'properties') {
    if (sort === 'beds') return { field: 'bedrooms', dir: 'desc' };
    if (sort === 'baths') return { field: 'bathrooms', dir: 'desc' };
    if (sort === 'sqft' || sort === 'lot') return { field: 'area_sqft', dir: 'desc' };
  }
  return null;
}

// Intent bucket keeps sale/rent price distributions from sharing a median.
// Mirrors listingPurpose normalization (sell/sale->sale, rent/lease/pg->rent).
function intentBucketForListingPurpose(listingPurpose?: string): string {
  if (typeof listingPurpose !== 'string' || !listingPurpose.trim()) return 'all';
  return /rent|lease|\bpg\b/i.test(listingPurpose) ? 'rent' : 'sale';
}

function quantileKey(region: string, field: string, intentBucket: string): string {
  return `q:v2:${region}:${field}:${intentBucket}`;
}

export interface QuantileComputeOpts {
  // Base filters for the compute query (MUST exclude any quantileRange —
  // computing percentiles on an already-narrowed set ratchets thresholds).
  must: any[];
  filters: any[];
  // Region geo box the thresholds describe (reconstructed from regionForBounds).
  regionBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  // ES index (single alias or [props, projects] — one multi-index call so
  // TDigest merges instead of averaging per-index percentiles).
  index: string | string[];
  timeoutMs?: number;
}

export interface QuantileComputeOpts {
  // Base filters for the compute query (MUST exclude any quantileRange —
  // computing percentiles on an already-narrowed set ratchets thresholds).
  must: any[];
  filters: any[];
  // Region geo box the thresholds describe (reconstructed from regionForBounds).
  regionBounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  // ES index (single alias or [props, projects] — one multi-index call so
  // TDigest merges instead of averaging per-index percentiles).
  index: string | string[];
  timeoutMs?: number;
}

// Lookup-only (list-only callers, cron prewarm reads). Tile paths should use
// getOrComputeQuantileThresholds below (runtime compute, no cron needed).
export async function getQuantileThresholds(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  sort: string | undefined,
  scope: string,
  opts?: { listingPurpose?: string }
): Promise<QuantileThresholds | null> {
  const q = sortFieldForQuantile(sort, scope);
  if (!q) return null;
  const region = regionForBounds(bounds);
  const key = quantileKey(region, q.field, intentBucketForListingPurpose(opts?.listingPurpose));
  try {
    const cached = await cacheGet<QuantileThresholds>(key);
    if (cached) return cached;
  } catch { /* miss -> no-range fallback */ }
  return null;
}

// Runtime compute-on-miss: first request needing thresholds for a
// region×field×intent runs ONE size:0 TDigest agg (via runAgg, supplied by the
// route which owns the ES client + base filters); concurrent requests coalesce
// on the quantile key; result cached 24h+jitter. Any failure -> null fallback
// (un-narrowed grid). Steady-state added QPS ≈ keys/TTL ≈ 0.
export async function getOrComputeQuantileThresholds(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  sort: string | undefined,
  scope: string,
  opts: {
    listingPurpose?: string;
    runAgg: (o: QuantileComputeOpts) => Promise<{ p50?: number; p90?: number } | null>;
    baseMust: any[];
    baseFilters: any[];
    index: string | string[];
    timeoutMs?: number;
  }
): Promise<QuantileThresholds | null> {
  const q = sortFieldForQuantile(sort, scope);
  if (!q) return null;
  const region = regionForBounds(bounds);
  const intentBucket = intentBucketForListingPurpose(opts.listingPurpose);
  const key = quantileKey(region, q.field, intentBucket);
  try {
    const cached = await cacheGet<QuantileThresholds>(key);
    if (cached) return cached;
  } catch { /* miss -> compute below */ }
  return quantileSingleflight(key, async () => {
    try {
      // Coalesced losers may find the winner already cached.
      const raced = await cacheGet<QuantileThresholds>(key).catch(() => null);
      if (raced) return raced;
      const [rlat, rlon] = region.split(':').map(Number);
      if (!Number.isFinite(rlat) || !Number.isFinite(rlon)) return null;
      const vals = await opts.runAgg({
        must: opts.baseMust,
        filters: opts.baseFilters,
        regionBounds: { minLat: rlat, maxLat: rlat + 1, minLng: rlon, maxLng: rlon + 1 },
        index: opts.index,
        timeoutMs: opts.timeoutMs ?? 2000,
      }).catch(() => null);
      if (!vals) return null;
      const { p50, p90 } = vals;
      // Validate before caching: finite + ordered (created_at arrives as
      // epoch_millis numbers — same check). Never cache garbage.
      if (p50 != null && !Number.isFinite(p50)) return null;
      if (p90 != null && !Number.isFinite(p90)) return null;
      if (p50 == null && p90 == null) return null;
      if (p50 != null && p90 != null && p50 > p90) return null;
      const out: QuantileThresholds = {
        ...(p50 != null ? { p50 } : {}),
        ...(p90 != null ? { p90 } : {}),
        updatedAt: new Date().toISOString(),
        version: 'v2',
      };
      // TTL jitter so keys don't expire in lockstep (anti-herd).
      const ttl = 86400 + Math.floor(Math.random() * 7200);
      await storeQuantileThresholds(region, q.field, out, intentBucket, ttl).catch(() => {});
      return out;
    } catch {
      return null;
    }
  });
}

// Build an additional range clause narrowing MAP agg to top quantile.
// price_desc/newest/beds/baths/sqft/lot -> gte p90 (top 10%);
// price_asc -> lte p50 (bottom half).
// Returns null when no thresholds (fallback = Phase 4 un-narrowed).
export function quantileRangeForSort(
  thresholds: QuantileThresholds | null,
  sort: string | undefined,
  scope: string
): any | null {
  if (!thresholds) return null;
  const q = sortFieldForQuantile(sort, scope);
  if (!q) return null;
  // Zoom gate lives in callers (map-data/map-tiles, z<10): street-level views
  // skip narrowing so small viewports never hide pins behind a top-decile cut.
  if ((sort === 'price_desc' || sort === 'newest' || sort === 'beds' || sort === 'baths' || sort === 'sqft' || sort === 'lot') && typeof thresholds.p90 === 'number') {
    return { range: { [q.field]: { gte: thresholds.p90 } } };
  }
  if (sort === 'price_asc' && typeof thresholds.p50 === 'number') {
    return { range: { [q.field]: { lte: thresholds.p50 } } };
  }
  return null;
}

export async function storeQuantileThresholds(
  region: string,
  field: string,
  thresholds: QuantileThresholds,
  intentBucket = 'all',
  ttlSeconds = 86400
): Promise<void> {
  await cacheSet(quantileKey(region, field, intentBucket), thresholds, ttlSeconds);
}

export { regionForBounds, sortFieldForQuantile };
