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

export function buildFilterHash(filters: Record<string, any>): string {
  let hash = 0;
  const str = JSON.stringify(filters);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
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
