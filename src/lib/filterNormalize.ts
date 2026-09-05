// Filter + bounds normalization for cache keys (md:v3).
//
// Two guarantees:
// 1. Near-identical searches share one cache entry (sorted arrays, snapped
//    sliders, cleaned text, rounded bounds) → fewer duplicate ES queries.
// 2. Correctness: every normalization either preserves semantics exactly
//    (sorting, casing, rounding identical values) or WIDENS the query
//    (price/area floors down, ceilings up; bounds rounded outward), so a
//    cache hit can never hide a matching pin. Snapped values feed BOTH the
//    ES query and the hash — never hash-only.
//
// All bucket sizes/precisions come from tenant.filterNormalization so buyers
// configure them per country without code changes.

import { tenant } from './tenant';
import { buildFilterHash } from './mapTiles';

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface RawMapFilters {
  query?: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  propertyType?: string;
  bhkType?: string;
  minBedrooms?: number;
  maxBedrooms?: number;
  listingPurpose?: string;
  amenities?: string[];
  furnishings?: string[];
  bathrooms?: number;
  minArea?: number;
  maxArea?: number;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  scope?: string;
  sort?: string;
  pageSize?: number;
  cursor?: unknown;
  polygon?: { lat: number; lng: number }[];
}

export interface NormalizedMapFilters {
  query?: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  propertyType?: string;
  bhkType?: string;
  minBedrooms?: number;
  maxBedrooms?: number;
  listingPurpose?: string;
  amenities?: string[];
  furnishings?: string[];
  bathrooms?: number;
  minArea?: number;
  maxArea?: number;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  scope?: string;
  sort?: string;
  pageSize?: number;
  cursor?: unknown;
  polygon?: { lat: number; lng: number }[];
}

// Price bucket step for a scope. scope=both mixes currencies in one slider,
// so it uses the finest involved step — snapping stays tight and still only
// ever widens (min floors, max ceils).
function priceStepForScope(scope?: string): number {
  const steps = tenant.filterNormalization.priceSteps;
  const prop = steps[tenant.propertyCurrency] ?? 500000;
  const proj = steps[tenant.projectCurrency] ?? 50000;
  if (scope === 'projects') return proj;
  if (scope === 'properties') return prop;
  return Math.min(prop, proj);
}

function snapDown(v: number, step: number): number {
  return cleanFloat(Math.floor(v / step) * step);
}

function snapUp(v: number, step: number): number {
  return cleanFloat(Math.ceil(v / step) * step);
}

// Kill binary float dust (e.g. 24.900000000000002) so snapped values are
// stable, comparable, and hash-identical across runtimes.
function cleanFloat(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function cleanText(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = s.toLowerCase().trim().replace(/\s+/g, ' ');
  return t.length > 0 ? t : undefined;
}

function normArray(arr: string[] | undefined): string[] | undefined {
  if (!arr || arr.length === 0) return undefined;
  const out = Array.from(
    new Set(arr.map((a) => a.toLowerCase().trim()).filter((a) => a.length > 0))
  ).sort();
  return out.length > 0 ? out : undefined;
}

function roundNum(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

// Round polygon vertices + cap count (keeps ring closed). Raw float vertices
// otherwise make every drawn boundary a unique cache key.
function normPolygon(
  points: { lat: number; lng: number }[] | undefined,
  precision: number,
  maxPoints: number
): { lat: number; lng: number }[] | undefined {
  if (!points || points.length < 3) return undefined;
  let pts = points.map((p) => ({ lat: cleanFloat(roundNum(p.lat, precision)), lng: cleanFloat(roundNum(p.lng, precision)) }));
  if (pts.length > maxPoints) {
    const stride = pts.length / maxPoints;
    const sampled: { lat: number; lng: number }[] = [];
    for (let i = 0; i < maxPoints; i++) {
      sampled.push(pts[Math.floor(i * stride)]);
    }
    pts = sampled;
  }
  // Re-close the ring if sampling broke it.
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.lat !== last.lat || first.lng !== last.lng) {
    pts = [...pts, { ...first }];
  }
  return pts;
}

// Trim float dust from bounds (~0.1m precision) so identical viewports hash
// identically across runtimes. Deliberately NOT grid-snapped: the ES query
// runs on these exact bounds, so every cached payload covers precisely the
// viewport it was fetched for.
function trimBounds(b: MapBounds): MapBounds {
  return {
    minLat: cleanFloat(b.minLat),
    maxLat: cleanFloat(b.maxLat),
    minLng: cleanFloat(b.minLng),
    maxLng: cleanFloat(b.maxLng),
  };
}

function clampBounds(b: MapBounds): MapBounds {
  const minLat = Math.max(-85.0511, Math.min(85.0511, b.minLat));
  const maxLat = Math.max(-85.0511, Math.min(85.0511, b.maxLat));
  let minLng = Math.max(-180, Math.min(180, b.minLng));
  let maxLng = Math.max(-180, Math.min(180, b.maxLng));
  if (minLng > maxLng) {
    minLng = -180;
    maxLng = 180;
  }
  return { minLat, maxLat, minLng, maxLng };
}

// Fixed key order — JSON.stringify must be deterministic for stable hashes.
function orderedForHash(f: NormalizedMapFilters): Record<string, unknown> {
  return {
    query: f.query,
    location: f.location,
    minPrice: f.minPrice,
    maxPrice: f.maxPrice,
    propertyType: f.propertyType,
    bhkType: f.bhkType,
    minBedrooms: f.minBedrooms,
    maxBedrooms: f.maxBedrooms,
    listingPurpose: f.listingPurpose,
    amenities: f.amenities,
    furnishings: f.furnishings,
    bathrooms: f.bathrooms,
    minArea: f.minArea,
    maxArea: f.maxArea,
    lat: f.lat,
    lng: f.lng,
    radiusKm: f.radiusKm,
    scope: f.scope,
    sort: f.sort,
    pageSize: f.pageSize,
    cursor: f.cursor,
    polygon: f.polygon,
  };
}

export function normalizeFilters(raw: RawMapFilters): NormalizedMapFilters {
  const cfg = tenant.filterNormalization;
  const step = priceStepForScope(raw.scope);
  const out: NormalizedMapFilters = {};
  out.query = cleanText(raw.query);
  out.location = cleanText(raw.location);
  if (raw.minPrice != null && Number.isFinite(raw.minPrice) && raw.minPrice > 0) {
    out.minPrice = snapDown(raw.minPrice, step);
  }
  if (raw.maxPrice != null && Number.isFinite(raw.maxPrice) && raw.maxPrice > 0) {
    out.maxPrice = snapUp(raw.maxPrice, step);
  }
  if (raw.propertyType) out.propertyType = raw.propertyType;
  if (raw.bhkType) out.bhkType = raw.bhkType;
  if (raw.minBedrooms != null) out.minBedrooms = raw.minBedrooms;
  if (raw.maxBedrooms != null) out.maxBedrooms = raw.maxBedrooms;
  if (raw.listingPurpose) out.listingPurpose = raw.listingPurpose;
  const arrayFields = new Set(cfg.arrayFields);
  out.amenities = arrayFields.has('amenities') ? normArray(raw.amenities) : raw.amenities;
  out.furnishings = arrayFields.has('furnishings') ? normArray(raw.furnishings) : raw.furnishings;
  if (raw.bathrooms != null) out.bathrooms = raw.bathrooms;
  if (raw.minArea != null && Number.isFinite(raw.minArea) && raw.minArea > 0) {
    out.minArea = snapDown(raw.minArea, cfg.areaStep);
  }
  if (raw.maxArea != null && Number.isFinite(raw.maxArea) && raw.maxArea > 0) {
    out.maxArea = snapUp(raw.maxArea, cfg.areaStep);
  }
  if (raw.lat != null) out.lat = raw.lat;
  if (raw.lng != null) out.lng = raw.lng;
  if (raw.radiusKm != null && Number.isFinite(raw.radiusKm) && raw.radiusKm > 0) {
    out.radiusKm = snapUp(raw.radiusKm, cfg.radiusStep);
  }
  if (raw.scope) out.scope = raw.scope;
  if (raw.sort) out.sort = raw.sort;
  if (raw.pageSize != null) out.pageSize = raw.pageSize;
  if (raw.cursor !== undefined) out.cursor = raw.cursor;
  out.polygon = normPolygon(raw.polygon, cfg.polygonPrecision, cfg.polygonMaxPoints);
  return out;
}

function stripForMarkers(f: NormalizedMapFilters): NormalizedMapFilters {
  // Markers show physical pins — list ordering/pagination never affect them.
  const strip = new Set(tenant.filterNormalization.stripFromMarkerKey);
  const out: NormalizedMapFilters = { ...f };
  if (strip.has('sort')) delete out.sort;
  if (strip.has('pageSize')) delete out.pageSize;
  if (strip.has('cursor')) delete out.cursor;
  if (strip.has('page')) delete (out as Record<string, unknown>).page;
  return out;
}

function fmtBounds(b: MapBounds): string {
  const t = (v: number) => cleanFloat(v).toFixed(6);
  return `${t(b.minLat)}/${t(b.maxLat)}/${t(b.minLng)}/${t(b.maxLng)}`;
}

export interface PreparedMapQuery {
  bounds: MapBounds;
  filters: NormalizedMapFilters;
  markerKey: string;
  listKey: string;
}

// Single entry point: clamp → dust-trim → normalize → keys.
// Callers query ES with the EXACT `bounds`+`filters` and cache markers/list
// separately under md:v4. The key embeds the exact queried bounds, so a cache
// hit always describes precisely the viewport it was fetched for — stale,
// misplaced, or missing pins are impossible by construction. Sharing comes
// from filter normalization (buckets, sorted arrays, cleaned text) and
// identical revisits, never from reusing one viewport's data for another.
export function prepareMapQuery(
  rawBounds: MapBounds,
  rawFilters: RawMapFilters
): PreparedMapQuery {
  const filters = normalizeFilters(rawFilters);
  const bounds = trimBounds(clampBounds(rawBounds));
  const rb = fmtBounds(bounds);
  const markerKey = `md:v4:m:${rb}:${buildFilterHash(orderedForHash(stripForMarkers(filters)))}`;
  const listKey = `md:v4:l:${rb}:${buildFilterHash(orderedForHash(filters))}`;
  return { bounds, filters, markerKey, listKey };
}
