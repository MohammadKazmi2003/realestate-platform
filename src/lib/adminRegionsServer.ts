// Server-side registry for the tenant's admin-1 (state/emirate) boundaries.
//
// Asset layout (built by scripts/build-maptiler-geo.mjs):
//  - public/geo/regions-manifest.json  metadata + sha256 per region (small)
//  - public/geo/regions/<ID>.geojson   CANONICAL MapTiler geometry (verbatim)
//  - public/geo/overview.geojson       simplified always-on background layer
//
// There is no classified or indexed copy of the boundary: filtering resolves
// the same canonical shapes (outer rings + holes) that the client draws, and
// the manifest sha travels as a cache token so request keys never re-hash a
// multi-megabyte polygon (measured ~90 ms per FNV pass at 54k points).
//
// Loading policy: metadata (name/bbox/token) is cheap and always available
// after the manifest parse; geometry is read lazily once per process and
// cached. A missing/corrupt canonical file returns null (the route responds
// 503) rather than silently falling back to the simplified overview — the
// overview's area guard may narrow, and a narrowed boundary can hide matches.
import { readFileSync } from 'fs';
import path from 'path';
import { tenant } from '@/lib/tenant';

export interface LatLng {
  lat: number;
  lng: number;
}

/** One polygon of a region: exactly as MapTiler returned it (holes included). */
export interface RegionShape {
  outer: LatLng[];
  holes: LatLng[][];
}

export interface AdminRegionMeta {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  /** [minLng, minLat, maxLng, maxLat] from the canonical geometry. */
  bbox: [number, number, number, number];
  /** `<id>:<sha256[0..32]>` — stable cache-key token for this geometry. */
  token: string;
}

export interface AdminRegion extends AdminRegionMeta {
  shapes: RegionShape[];
  points: number;
  ringCount: number;
  holeCount: number;
}

interface ManifestRegion {
  file: string;
  name: string;
  country: string;
  countryCode: string;
  bbox: number[];
  points: number;
  rings: number;
  holes: number;
  sha256: string;
}

interface Manifest {
  source: string;
  attribution: string;
  generatedAt: string;
  version: string;
  regions: Record<string, ManifestRegion>;
}

let manifest: Manifest | null = null;
let manifestFailed = false;
const shapesCache = new Map<string, RegionShape[] | null>();

function manifestPath(): string {
  const rel = tenant.map.admin1?.manifest || 'geo/regions-manifest.json';
  return path.join(process.cwd(), 'public', rel);
}

function getManifest(): Manifest | null {
  if (manifest || manifestFailed) return manifest;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), 'utf8')) as Manifest;
    if (!parsed || typeof parsed !== 'object' || !parsed.regions) throw new Error('missing regions');
    manifest = parsed;
  } catch (e) {
    manifestFailed = true;
    if (typeof console !== 'undefined') {
      console.warn('[adminRegions] manifest unavailable:', (e as Error)?.message);
    }
  }
  return manifest;
}

function ringFromCoordinates(raw: unknown): LatLng[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter(
      (c): c is [number, number] =>
        Array.isArray(c) && Number.isFinite(Number((c as unknown[])[0])) && Number.isFinite(Number((c as unknown[])[1]))
    )
    .map((c) => ({ lat: c[1], lng: c[0] }));
}

function loadShapes(meta: ManifestRegion): RegionShape[] | null {
  const cached = shapesCache.get(meta.file);
  if (cached !== undefined) return cached;
  let shapes: RegionShape[] | null = null;
  try {
    const geo = JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'geo', meta.file), 'utf8'));
    const feature = (geo?.features || [])[0];
    const g = feature?.geometry;
    const polys: unknown[] =
      g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)
        ? g.coordinates
        : g?.type === 'Polygon' && Array.isArray(g.coordinates)
          ? [g.coordinates]
          : [];
    const out: RegionShape[] = [];
    for (const poly of polys) {
      if (!Array.isArray(poly) || !poly.length) continue;
      const outer = ringFromCoordinates((poly as unknown[])[0]);
      if (outer.length < 3) continue;
      const holes: LatLng[][] = [];
      for (let i = 1; i < (poly as unknown[]).length; i++) {
        const hole = ringFromCoordinates((poly as unknown[])[i]);
        if (hole.length >= 3) holes.push(hole);
      }
      out.push({ outer, holes });
    }
    if (out.length) shapes = out;
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn(`[adminRegions] canonical geometry ${meta.file} unavailable:`, (e as Error)?.message);
    }
  }
  shapesCache.set(meta.file, shapes);
  return shapes;
}

export function adminRegionsEnabled(): boolean {
  return !!tenant.map.admin1 && Object.keys(getManifest()?.regions || {}).length > 0;
}

function metaOf(id: string): AdminRegionMeta | null {
  if (!id || !/^(IN|AE)-[A-Z]{2}$/.test(id)) return null;
  const m = getManifest();
  const r = m?.regions?.[id];
  if (!r || !Array.isArray(r.bbox) || r.bbox.length !== 4) return null;
  return {
    id,
    name: r.name,
    country: r.country,
    countryCode: r.countryCode,
    bbox: r.bbox as [number, number, number, number],
    token: `${id}:${String(r.sha256).slice(0, 32)}`,
  };
}

/** Metadata only — no geometry read. Used where the boundary itself is not queried. */
export function getAdminRegionLite(id: string): AdminRegionMeta | null {
  return metaOf(id);
}

/** Metadata + canonical shapes (lazy, cached). Null when geometry is unavailable. */
export function getAdminRegion(id: string): AdminRegion | null {
  const meta = metaOf(id);
  if (!meta) return null;
  const m = getManifest();
  const r = m?.regions?.[id];
  if (!r) return null;
  const shapes = loadShapes(r);
  if (!shapes) return null;
  return {
    ...meta,
    shapes,
    points: r.points,
    ringCount: r.rings,
    holeCount: r.holes,
  };
}

/**
 * Full list with canonical geometry for every region — tests and tooling only
 * (reads ~18 MB once). Request paths use getAdminRegion(id).
 */
export function listAdminRegions(): AdminRegion[] {
  const m = getManifest();
  if (!m) return [];
  return Object.keys(m.regions)
    .map((id) => getAdminRegion(id))
    .filter((r): r is AdminRegion => r !== null);
}
