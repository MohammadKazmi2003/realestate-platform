// Locality polygon selection from OSM (Nominatim) results.
//
// MapTiler's geocoder returns centroids for city/neighborhood `place` entities
// (Point/MultiPoint lookups — no polygon), so locality boundaries cannot come
// from it. OSM carries the real polygons (e.g. Dubai Marina relation 11912728,
// Dubai Investment Park neighbourhood way 874795301) and Nominatim exposes them
// via `polygon_geojson=1`.
//
// Pure + unit-tested. The key rule is CONTAINMENT: only a polygon that
// actually contains the searched point is eligible (even-odd, holes honored).
// That is what rejects a same-named sub-parcel, a station building, or a lake
// that a loose name match would otherwise draw. Ranking prefers administrative
// boundaries, then place/neighbourhood polygons, then landuse; ties go to the
// larger polygon (community outline over an individual parcel).

export interface PlacePolygon {
  rings: { lat: number; lng: number }[][];
  bbox: [number, number, number, number];
  osmType: string;
  osmId: number;
  name: string;
}

const MIN_AREA_DEG2 = 1e-8;
const MAX_AREA_DEG2 = 0.5;
const MAX_POINTS = 20000;

type LngLat = [number, number];

function polygonsOf(geometry: unknown): LngLat[][][] | null {
  const g = geometry as { type?: string; coordinates?: unknown } | null;
  if (!g) return null;
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) return [g.coordinates as LngLat[][]];
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) return g.coordinates as LngLat[][][];
  return null;
}

function inRing(lng: number, lat: number, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygons(lng: number, lat: number, polys: LngLat[][][]): boolean {
  return polys.some((poly) => {
    const outer = poly[0];
    if (!Array.isArray(outer) || outer.length < 3) return false;
    if (!inRing(lng, lat, outer)) return false;
    return !poly.slice(1).some((hole) => Array.isArray(hole) && hole.length >= 3 && inRing(lng, lat, hole));
  });
}

function outerAreaDeg2(polys: LngLat[][][]): number {
  let area = 0;
  for (const poly of polys) {
    const ring = poly[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    area += Math.abs(s / 2);
  }
  return area;
}

function pointCount(polys: LngLat[][][]): number {
  let n = 0;
  for (const poly of polys) for (const ring of poly) if (Array.isArray(ring)) n += ring.length;
  return n;
}

// 0 = administrative boundary, 1 = place/neighbourhood polygon, 2 = landuse/other.
function tierOf(candidate: Record<string, unknown>): number {
  const category = String(candidate.category ?? candidate.class ?? '').toLowerCase();
  const type = String(candidate.type ?? '').toLowerCase();
  if ((category === 'boundary' && type === 'administrative') || type === 'local_authority') return 0;
  if (
    category === 'place' ||
    ['neighbourhood', 'suburb', 'quarter', 'locality', 'borough', 'city', 'town', 'village'].includes(type)
  ) {
    return 1;
  }
  return 2;
}

export function selectPlacePolygon(
  candidates: unknown,
  center: { lat: number; lng: number }
): PlacePolygon | null {
  if (!Array.isArray(candidates) || !Number.isFinite(center?.lat) || !Number.isFinite(center?.lng)) return null;

  const eligible: { candidate: Record<string, unknown>; polys: LngLat[][][]; area: number; points: number; tier: number }[] = [];
  for (const raw of candidates) {
    const candidate = raw as Record<string, unknown> | null;
    if (!candidate) continue;
    const polys = polygonsOf(candidate.geojson);
    if (!polys || polys.length === 0) continue;
    if (!inPolygons(center.lng, center.lat, polys)) continue;
    const area = outerAreaDeg2(polys);
    if (area < MIN_AREA_DEG2 || area > MAX_AREA_DEG2) continue;
    const points = pointCount(polys);
    if (points < 3 || points > MAX_POINTS) continue;
    eligible.push({ candidate, polys, area, points, tier: tierOf(candidate) });
  }
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.area !== b.area) return b.area - a.area;
    if (a.points !== b.points) return b.points - a.points;
    const rank = (t: string) => (t === 'relation' ? 0 : 1);
    return rank(String(a.candidate.osm_type ?? '')) - rank(String(b.candidate.osm_type ?? ''));
  });

  const best = eligible[0];
  const rings: { lat: number; lng: number }[][] = [];
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const poly of best.polys) {
    const outer = poly[0];
    if (!Array.isArray(outer) || outer.length < 3) continue;
    const ring: { lat: number; lng: number }[] = [];
    for (const [lng, lat] of outer) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      ring.push({ lat, lng });
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  if (rings.length === 0 || !Number.isFinite(minLng)) return null;

  return {
    rings,
    bbox: [minLng, minLat, maxLng, maxLat],
    osmType: String(best.candidate.osm_type ?? ''),
    osmId: Number(best.candidate.osm_id ?? 0),
    name: String(best.candidate.name ?? best.candidate.display_name ?? '').slice(0, 200),
  };
}
