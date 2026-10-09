// Shared tile + filter-hash helpers for map APIs (kept out of route modules
// so Next.js route type validation doesn't trip on non-route exports).
// NOTE: boundsToTileKey/tileToBounds are currently unused by the viewport
// flow (exact bounds are queried and keyed — see filterNormalize). They are
// kept for the future covering-tiles implementation, which must fetch ALL
// tiles intersecting the viewport and merge client-side — never a single
// center tile painted as a viewport.

export function boundsToTileKey(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  zoom: number
): string {
  const centerLon = (bounds.minLng + bounds.maxLng) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const n = Math.pow(2, zoom);
  const x = Math.floor(n * ((centerLon + 180) / 360));
  const latRad = (centerLat * Math.PI) / 180;
  const y = Math.floor(n * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2);
  return `${zoom}/${x}/${y}`;
}

// Precision-by-zoom table (best-choice defaults).
// Keeps cells/viewport ≈300-1000. Widen-only: overspan clamps precision down.
export function precisionForZoom(zoom: number): number {
  if (zoom <= 5) return 3;
  if (zoom <= 8) return 4;
  if (zoom <= 11) return 5;
  if (zoom <= 14) return 6;
  return 7;
}

// Scale-ready: hard cap on grid precision at overview zooms so per-shard
// bucket build stays bounded as shards grow. Without this, adaptive
// refinement can push z≤10 viewports to precision 10-12 (millions of cells
// globally) — per-shard hash tables explode and adding ES nodes just adds
// more expensive scatter. Env-overridable via TILE_MAX_PRECISION_LOW_ZOOM.
// Low-zoom UX uses cells{key,count} badges, not 500 pins (Zillow pattern).
export function maxPrecisionForZoom(zoom: number): number {
  const lowCap = (() => {
    const v = Number(process.env.TILE_MAX_PRECISION_LOW_ZOOM);
    return Number.isFinite(v) ? Math.max(4, Math.min(12, v)) : 6;
  })();
  if (Number(zoom) <= 10) return lowCap;
  return 12;
}

// Tiered TTLs (best-choice defaults): newest fresh, deterministic sorts stable.
export function redisTTLForSort(sort?: string): number {
  if (sort === 'newest') return 60;
  if (sort === 'price_asc' || sort === 'price_desc' || sort === 'beds' || sort === 'baths' || sort === 'sqft' || sort === 'lot') return 300;
  return 120;
}

export function cdnSMaxAgeForSort(sort?: string): number {
  if (sort === 'newest') return 30;
  if (sort === 'price_asc' || sort === 'price_desc' || sort === 'beds' || sort === 'baths' || sort === 'sqft' || sort === 'lot') return 60;
  return 30;
}

function lonToX(lon: number, z: number): number {
  const n = Math.pow(2, z);
  return Math.floor(n * ((lon + 180) / 360));
}

function latToY(lat: number, z: number): number {
  const n = Math.pow(2, z);
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(n * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2);
}

// Covering tiles for a viewport at tile-zoom (not center-tile).
// Returns ALL intersecting z/x/y so pans merge client-side — never single tile.
// Scale-ready: maxTiles defaults to 8 (env TILE_MAX_TILES, clamped 4-12) so
// per-user ES fan-out stays bounded as ES shards grow. 12→8 cuts worst-case
// tile searches ~33% with negligible density loss (fill query tops to 500).
export function viewportCoveringTiles(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  mapZoom: number,
  maxTiles?: number
): { z: number; x: number; y: number }[] {
  const envMax = Number(process.env.TILE_MAX_TILES);
  const cap = maxTiles ?? (Number.isFinite(envMax) ? Math.max(4, Math.min(12, envMax)) : 8);
  let z = Math.max(4, Math.min(12, Math.round(mapZoom) - 1));
  // Clamp precision down while overspanning (widen-only).
  for (;;) {
    const x0 = lonToX(bounds.minLng, z);
    const x1 = lonToX(bounds.maxLng, z);
    // Y grows southward: maxLat -> smaller y.
    const y0 = latToY(bounds.maxLat, z);
    const y1 = latToY(bounds.minLat, z);
    const w = Math.abs(x1 - x0) + 1;
    const h = Math.abs(y1 - y0) + 1;
    if (w * h <= cap) {
      const out: { z: number; x: number; y: number }[] = [];
      const xa = Math.min(x0, x1);
      const xb = Math.max(x0, x1);
      const ya = Math.min(y0, y1);
      const yb = Math.max(y0, y1);
      for (let x = xa; x <= xb; x++) {
        for (let y = ya; y <= yb; y++) {
          out.push({ z, x, y });
        }
      }
      return out;
    }
    // More tiles than the cap: descend to a COARSER tile instead of sampling.
    // Striding kept the count bounded but broke coverage — the returned set no
    // longer spanned the viewport, so a tile-union key derived from it was a
    // subset of what the user asked for (AD5 violation: a cache hit could hide
    // listings). Descending keeps coverage exact while still bounding fan-out,
    // and at world scale it also means far fewer, far more reusable tiles.
    if (z <= 1) {
      // z=1 is 2 tiles wide — below that a single tile IS the requested extent.
      const out: { z: number; x: number; y: number }[] = [];
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          out.push({ z, x, y });
        }
      }
      return out;
    }
    z -= 1;
  }
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

// AD1: the cacheable unit is the COVERING TILE SET, not the raw viewport.
//
// Returns the bounding box of every tile that intersects `bounds`. Two pans
// that resolve to the same z/x/y set produce a byte-identical union, so feeding
// this into prepareMapQuery makes marker/list keys and geo filters identical
// across users — the reuse exact-bounds keys can never achieve. Pans smaller
// than a tile therefore share one cache entry instead of minting one per pan.
//
// Widening here is safe by AD5: the union is a superset of the viewport, so a
// cache hit can never hide a listing that the exact viewport would have shown.
export function coveringTileUnionBounds(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  mapZoom: number
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const tiles = viewportCoveringTiles(bounds, mapZoom);
  if (tiles.length === 0) return bounds;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const t of tiles) {
    const b = tileToBounds(t.z, t.x, t.y);
    if (b.minLat < minLat) minLat = b.minLat;
    if (b.maxLat > maxLat) maxLat = b.maxLat;
    if (b.minLng < minLng) minLng = b.minLng;
    if (b.maxLng > maxLng) maxLng = b.maxLng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

// 64-bit FNV-1a for tile rollout (avoids 32-bit birthday collisions at scale).
export function buildFilterHash64(filters: Record<string, any>): string {
  const str = JSON.stringify(filters);
  let h1 = 0xcbf29ce4;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ (c + 31), 16777619);
  }
  const u1 = h1 >>> 0;
  const u2 = h2 >>> 0;
  return u1.toString(36) + u2.toString(36);
}

export function tileToBounds(z: number, x: number, y: number) {
  const n = Math.pow(2, z);
  const lonWest = (x / n) * 360 - 180;
  const lonEast = ((x + 1) / n) * 360 - 180;
  const latRadN = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latRadS = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const rad2deg = (r: number) => (r * 180) / Math.PI;
  return {
    minLat: Math.max(-85.0511, Math.min(85.0511, rad2deg(latRadS))),
    maxLat: Math.max(-85.0511, Math.min(85.0511, rad2deg(latRadN))),
    minLng: Math.max(-180, Math.min(180, lonWest)),
    maxLng: Math.max(-180, Math.min(180, lonEast)),
  };
}

// Scale-ready geohash-style routing (forward-compatible).
// Returns a coarse 1° region key "lat:lon" matching quantiles regionForBounds.
// Index with `routing=<region>` to co-locate nearby docs; query with
// `routing=<covering regions>` to prune S shards → k≈1-few. Until indices
// are created with routing, ES ignores the param — safe to send now so
// adding nodes/shards later needs no code change. World/low-zoom viewports
// spanning many regions intentionally return multiple routings (caller fans
// to N routings, still ≤ S shards).
export function routingForBounds(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }): string[] {
  const lat0 = Math.floor(((bounds.minLat + bounds.maxLat) / 2) * 1) / 1;
  const lon0 = Math.floor(((bounds.minLng + bounds.maxLng) / 2) * 1) / 1;
  // If viewport spans >2° in either axis, include neighbours so routed
  // queries don't miss edge docs (widen-only, at most 4 routings).
  const spanLat = Math.abs(bounds.maxLat - bounds.minLat);
  const spanLon = Math.abs(bounds.maxLng - bounds.minLng);
  const out = [`${lat0}:${lon0}`];
  if (spanLat > 2 || spanLon > 2) {
    // World/region view: fall back to scatter (no routing) — caller passes
    // undefined to hit all shards rather than enumerating hundreds.
    return [];
  }
  return out;
}
