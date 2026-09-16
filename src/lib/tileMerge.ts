// Client+server merge: dedupe by type:id -> clip to exact viewport -> sort-rank stride to 500.
// Reuses existing paintMarkers/updateSourceData/updateCircleRadius verbatim — no renderer change.

export interface TileMarker {
  id: string;
  entity_type?: string;
  lat: number | null;
  lon: number | null;
  price?: number;
  [k: string]: any;
}

export function dedupeMarkers(markers: TileMarker[]): TileMarker[] {
  const seen = new Set<string>();
  const out: TileMarker[] = [];
  for (const m of markers) {
    if (!m || (m as any).id == null) continue;
    const key = `${(m as any).entity_type || ''}:${(m as any).id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export function clipToViewport(
  markers: TileMarker[],
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }
): TileMarker[] {
  return markers.filter((m) => {
    if (m.lat == null || m.lon == null) return false;
    return m.lat >= bounds.minLat && m.lat <= bounds.maxLat && m.lon >= bounds.minLng && m.lon <= bounds.maxLng;
  });
}

function bedsValue(m: TileMarker): number {
  // Markers carry bhk_type labels ("2 BHK"), not the bedrooms scalar —
  // parse the leading int for ordering (documented approximation).
  const b = (m as any).bhk_type;
  if (typeof b === 'string') {
    const n = parseInt(b, 10);
    if (Number.isFinite(n)) return n;
  }
  if (typeof b === 'number' && Number.isFinite(b)) return b;
  return 0;
}

function sortValue(m: TileMarker, sort?: string): number {
  if (sort === 'price_asc' || sort === 'price_desc') return (m as any).price || 0;
  if (sort === 'newest' || sort === 'popular') {
    // popular has no deterministic tile ordering — documented newest fallback.
    const t = (m as any).created_at ? Date.parse((m as any).created_at) : NaN;
    return Number.isFinite(t) ? t : 0;
  }
  if (sort === 'beds') return bedsValue(m);
  if (sort === 'baths') return (m as any).bathrooms ?? 0;
  // sqft + lot both order by area_sqft (no separate lot field — documented).
  if (sort === 'sqft' || sort === 'lot') return (m as any).area_sqft ?? 0;
  return (m as any).price || 0;
}

// Stride-sample to cap while preserving spatial spread + sort rank:
// sort globally by sortKey, then take every k-th to keep geography mixed.
export function strideToCap(markers: TileMarker[], cap = 500, sort?: string): TileMarker[] {
  if (markers.length <= cap) return markers;
  const dir = sort === 'price_asc' ? 1 : -1;
  const sorted = [...markers].sort((a, b) => {
    if (sort === 'newest' || sort === 'popular') {
      const ta = (a as any).created_at ? Date.parse((a as any).created_at) : 0;
      const tb = (b as any).created_at ? Date.parse((b as any).created_at) : 0;
      return (tb - ta) || String((a as any).id).localeCompare(String((b as any).id));
    }
    const va = sortValue(a, sort);
    const vb = sortValue(b, sort);
    if (va === vb) return String((a as any).id).localeCompare(String((b as any).id));
    return (vb - va) * (dir === 1 ? -1 : 1);
  });
  // Interleave: take top by rank but stride to avoid one-cluster collapse.
  // Simple deterministic stride: step = len/cap, pick floor(i*step).
  const step = markers.length / cap;
  const out: TileMarker[] = [];
  for (let i = 0; i < cap; i++) {
    out.push(sorted[Math.floor(i * step)]);
  }
  return out;
}

export function mergeTileMarkers(
  tileResults: { markers: TileMarker[] }[],
  viewport: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  sort?: string,
  cap = 500
): TileMarker[] {
  const all: TileMarker[] = [];
  for (const t of tileResults) {
    if (t && Array.isArray(t.markers)) all.push(...t.markers);
  }
  return strideToCap(clipToViewport(dedupeMarkers(all), viewport), cap, sort);
}
