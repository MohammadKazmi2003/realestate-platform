'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { coveringTileUnionBounds } from '@/lib/mapTiles';
import maplibregl, { LngLatBounds } from 'maplibre-gl';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { FaMap, FaList, FaSpinner, FaCrosshairs, FaBuilding, FaHome } from 'react-icons/fa';
import Header from '@/app/components/Header';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';
import { ProjectCard } from '@/app/components/ProjectCard';
import { cn } from '@/lib/utils';
import { searchProperties, mapEsResultToPropertyCard, autocompleteSearch } from '@/lib/searchClient';
import { getLookup } from '@/lib/lookupCache';
import type { Project } from '@/lib/types';
import { MarkerLruCache } from '@/lib/markerCache';
import { setupMapLayers, updateSourceData, updateCircleRadius, setHighlightedPoint, setHighlightState, removeMapLayers, type ClusterPoint } from '@/lib/map/mapLayers';
import { ADMIN_LAYERS, setupAdminLayers, applyAdminTier, setAdminHover, clearAdminHover, setAdminSelected, setSelectedDetail, setOverviewSelectedExcluded, setHoverDetail, setOverviewHoverExcluded, setAdminDetailState, removeAdminLayers } from '@/lib/map/adminLayers';
import { showStateTooltip, hideStateTooltip, destroyStateTooltip } from '@/lib/map/stateTooltip';
import { tenant } from '@/lib/tenant';
import { formatMoneyCompact } from '@/lib/format';
import { mergeUniqueById } from '@/lib/collections';
import { tileStringArray, tileNumberArray, tileGalleryComplete } from '@/lib/tileGallery';
import PriceRangeFilter, { PriceRangeValue } from '@/app/components/PriceRangeFilter';
import { IntentTabs } from '@/app/components/IntentTabs';
import { intentToListingPurpose, parseIntentFromSearch, withIntentInSearch, type Intent } from '@/lib/intent';
import { showPropertyPreview, hidePropertyPreview, showListingPreviewCard, hideListingPreviewCard, destroyPreviewCards, listingCardId, repositionListingCard } from '@/lib/map/previewCard';
import type { Feature } from 'geojson';

type PropertyBrowse = PropertyCardProps['property'] & {
  latitude: number | null;
  longitude: number | null;
};

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };
type SearchScope = 'properties' | 'projects' | 'both';
  type SortOption = 'popular' | 'newest' | 'price_asc' | 'price_desc' | 'beds' | 'baths' | 'sqft' | 'lot';

type ProjectBrowse = Project & {
  latitude: number | null;
  longitude: number | null;
};

const DEFAULT_CENTER: [number, number] = tenant.map.center;
const MAX_LIST_ITEMS = 500;
// Default viewport fits the tenant's home market with margin at the default
// container size (default tenant: whole India + Dubai projects at z4).
const DEFAULT_ZOOM = tenant.map.zoom;
// Interactive admin-1 (state/emirate) selection config; disabled via
// NEXT_PUBLIC_ADMIN1=0 or by leaving map.admin1 out of the tenant file.
const ADMIN1 = tenant.map.admin1;

// Price label for the highlighted speech-bubble marker — projects are priced
// in the tenant's project currency. Truncated so it always fits the fixed
// bubble width (~15 chars).
function formatHighlightPrice(type: string | undefined, price?: number): string {
  if (!price || price <= 0) return '';
  let label = formatMoneyCompact(
    price,
    type === 'project' ? tenant.projectCurrency : tenant.propertyCurrency
  );
  if (label.length > 15) {
    label = `${label.slice(0, 14)}…`;
  }
  return label;
}

type AutocompleteSuggestion = {
  type: 'location' | 'property' | 'project' | 'geocoded';
  text: string;
  entity: string;
  /** Stable MapTiler feature id — geometry is fetched by id on select so the
   * clicked entity can never mismatch the outline/filter. */
  id?: string;
  place_type?: string[];
  hasBoundary?: boolean;
  bbox?: number[];
  center?: number[];
  polygons?: { lat: number; lng: number }[][];
};

type BoundaryRing = { lat: number; lng: number };
type BoundaryRings = BoundaryRing[][];

/** All outer rings of a MapTiler GeoJSON geometry (shared Polygon/MultiPolygon
 * handling — a lone `Polygon` must NOT be wrapped an extra level). */
function allRingsFromGeometry(geo: any): BoundaryRings {
  if (!geo || !Array.isArray(geo.coordinates)) return [];
  const polys: number[][][][] =
    geo.type === 'MultiPolygon'
      ? geo.coordinates
      : geo.type === 'Polygon'
        ? [geo.coordinates]
        : [];
  const rings: BoundaryRings = [];
  for (const poly of polys) {
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      const pts: BoundaryRing[] = [];
      for (const coord of ring) {
        if (!Array.isArray(coord)) continue;
        const [lng, lat] = coord;
        if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push({ lat, lng });
      }
      if (pts.length >= 3) rings.push(pts);
    }
  }
  return rings;
}

/** A MapTiler bbox that collapses to a point (e.g. city `place` entries) can't
 * outline or filter anything — treat it as a center lookup instead. */
function isDegenerateBbox(bbox: number[]): boolean {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [west, south, east, north] = bbox;
  return ![west, south, east, north].every(Number.isFinite) || west === east || south === north;
}

/** Administrative place types that can carry a real boundary polygon. */
const ADMIN_PLACE_TYPES = new Set(['region', 'subregion', 'locality', 'municipality', 'neighborhood']);

/** Country segment = trailing comma part of a place_name (for same-country guard). */
function countryOf(placeName: string): string {
  const parts = placeName.split(',');
  return parts.length > 0 ? parts[parts.length - 1].trim().toLowerCase() : '';
}

/**
 * Point-place fallback: some city `place` entities (e.g. Mumbai, Dubai) have
 * no polygon of their own — only a point. Resolve matching administrative
 * areas from the suggestion list the user already saw (e.g. Mumbai City +
 * Suburban districts): same country, shared locality token, real
 * (non-degenerate) bbox, ADMIN place types only. The previous non-admin tier
 * drew whatever polygon happened to share a name (e.g. Kharghar Lake), which
 * is exactly the misleading outline class this fallback must never produce.
 * Deliberately uses the visible list — NOT a fresh text re-query, whose
 * full-text candidates differ (all `place`, all degenerate).
 * Returns merged rings + union bbox, or null when nothing qualifies.
 */
async function resolveAdminBoundary(
  text: string,
  suggestions: AutocompleteSuggestion[]
): Promise<{ rings: BoundaryRings; bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } } | null> {
  const locality = text.split(',')[0]?.trim().toLowerCase();
  if (!locality) return null;
  const homeCountry = countryOf(text);
  const relevant = (suggestions || []).filter(s => {
    if (!s || s.type !== 'geocoded' || !s.id) return false;
    if (!s.text.toLowerCase().includes(locality)) return false;
    if (homeCountry && countryOf(s.text) !== homeCountry) return false;
    if (!Array.isArray(s.place_type) || !s.place_type.some(t => ADMIN_PLACE_TYPES.has(t))) return false;
    const b = s.bbox || [];
    if (b.length !== 4 || b[0] === b[2] || b[1] === b[3]) return false;
    return true;
  });
  const rings: BoundaryRings = [];
  const boxes: number[][] = [];
  const settled = await Promise.allSettled(relevant.slice(0, 3).map(c => fetchGeometryById(c.id!)));
  relevant.slice(0, 3).forEach((c, i) => {
    if (settled[i].status === 'fulfilled') {
      const r = (settled[i] as PromiseFulfilledResult<BoundaryRings>).value;
      if (r.length > 0) {
        rings.push(...r);
        if (c.bbox?.length === 4) boxes.push(c.bbox);
      }
    }
  });
  if (rings.length === 0 || boxes.length === 0) return null;
  return {
    rings,
    bbox: {
      minLng: Math.min(...boxes.map(b => b[0])),
      minLat: Math.min(...boxes.map(b => b[1])),
      maxLng: Math.max(...boxes.map(b => b[2])),
      maxLat: Math.max(...boxes.map(b => b[3])),
    },
  };
}

/** Fetch exact geometry for a MapTiler feature id (the clicked entity itself,
 * never a fresh text query's first result). */
async function fetchGeometryById(featureId: string, signal?: AbortSignal): Promise<BoundaryRings> {
  const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
  if (!key) return [];
  const res = await fetch(
    `https://api.maptiler.com/geocoding/${encodeURIComponent(featureId)}.json?key=${key}&language=en`,
    { signal: signal || AbortSignal.timeout(4000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const geo = data.features?.[0]?.geometry;
  if (!geo || (geo.type !== 'MultiPolygon' && geo.type !== 'Polygon')) return [];
  return allRingsFromGeometry(geo);
}

/** Locality polygon from OSM (via /api/place-geometry) for city/neighborhood
 * entities MapTiler only knows as centroids. The server validates containment
 * against the searched point, so the returned outline is the polygon the
 * point is actually inside — never a same-named parcel or a bounding box. */
async function fetchPlaceGeometryFromOSM(
  text: string,
  center?: [number, number] | null
): Promise<{ rings: BoundaryRings; bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } } | null> {
  const q = text.trim();
  if (!q || !center) return null;
  const [lng, latNum] = center;
  if (!Number.isFinite(lng) || !Number.isFinite(latNum)) return null;
  try {
    const res = await fetch(
      `/api/place-geometry?q=${encodeURIComponent(q)}&lat=${latNum}&lng=${lng}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const rings: BoundaryRings = Array.isArray(data?.rings)
      ? data.rings
          .map((ring: unknown) =>
            (Array.isArray(ring) ? ring : [])
              .map((p: any) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
              .filter((p: { lat: number; lng: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
          )
          .filter((ring: { lat: number; lng: number }[]) => ring.length >= 3)
      : [];
    const b = data?.bbox;
    if (rings.length === 0 || !Array.isArray(b) || b.length !== 4) return null;
    return {
      rings,
      bbox: { minLng: b[0], minLat: b[1], maxLng: b[2], maxLat: b[3] },
    };
  } catch {
    return null;
  }
}

async function searchProjects(params: any): Promise<{ results: any[]; total: number; nextCursor?: any[] | null }> {
  try {
    const { signal, ...rest } = params;
    const res = await fetch('/api/projects/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rest),
      signal,
    });
    if (!res.ok) return { results: [], total: 0 };
    return res.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { results: [], total: 0 };
  }
}

function simplifyPolygon(points: { lat: number; lng: number }[], tolerance: number = 0.0005): { lat: number; lng: number }[] {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = simplifyPolygon(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPolygon(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}
function perpendicularDistance(p: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag === 0) return Math.sqrt((p.lat - a.lat) ** 2 + (p.lng - a.lng) ** 2);
  const ux = dx / mag;
  const uy = dy / mag;
  const px = p.lng - a.lng;
  const py = p.lat - a.lat;
  const proj = ux * px + uy * py;
  const closestX = a.lng + ux * proj;
  const closestY = a.lat + uy * proj;
  return Math.sqrt((p.lng - closestX) ** 2 + (p.lat - closestY) ** 2);
}


/**
 * Canonicalise map request bounds to the covering-tile union.
 *
 * The server already answers every map/pills request from the tile union, not
 * the raw viewport — so two users looking at the same tiles get byte-identical
 * payloads. But with exact bounds in the URL a CDN treats those as two
 * different resources and caches them separately, which is exactly the
 * hit-rate problem the tile-union Redis keys were introduced to solve. Snapping
 * the URL to the same unit the server caches under is what lets the edge share
 * a response across users. Pure math — safe in a client component.
 */
function canonicalTileBounds(
  b: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  zoom: number
) {
  const u = coveringTileUnionBounds(b, Number(zoom) || 10);
  const f = (v: number) => Number(v).toFixed(6);
  return { minLat: f(u.minLat), maxLat: f(u.maxLat), minLng: f(u.minLng), maxLng: f(u.maxLng) };
}

export default function BrowsePage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const router = useRouter();

  const [properties, setProperties] = useState<PropertyBrowse[]>([]);
  const [projects, setProjects] = useState<ProjectBrowse[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [markerCount, setMarkerCount] = useState(0);
  const [projectGroups, setProjectGroups] = useState<{ name: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [filterOpen, setFilterOpen] = useState(true);
  const [fullScreenResults, setFullScreenResults] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'compact'>('list');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [panelWidth, setPanelWidth] = useState(450);
  const sortByRef = useRef(sortBy);
  const resizerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [searchAsIMove, setSearchAsIMove] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [searchScope, setSearchScope] = useState<SearchScope>('both');
  // Intent tabs: Buy (Sale, default) | Rent (Rent only).
  // Projects hidden on Rent (sale inventory).
  const [intent, setIntent] = useState<Intent>('buy');
  const [filters, setFilters] = useState({ location: '', minPrice: '', maxPrice: '', bhkTypeId: '', propertyTypeId: '' });
  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);
  const [lookupMaps, setLookupMaps] = useState<{
    bhkIdToLabel: Record<number, string>;
    propTypeIdToName: Record<number, string>;
  }>({ bhkIdToLabel: {}, propTypeIdToName: {} });

  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Geocoded bounds from location search — used to filter search results
  // to the geocoded area instead of the current map viewport
  const geocodedBoundsRef = useRef<{ minLat: number; maxLat: number; minLng: number; maxLng: number } | null>(null);

  const [propertyTotal, setPropertyTotal] = useState(0);
  // totalRelation 'gte' means count was capped (P1: track 10K) — badge shows 10K+.
  const [totalRelation, setTotalRelation] = useState<string | undefined>(undefined);
  // Count of listings matching everything EXCEPT listing purpose, populated
  // only when the purpose filter zeroes results (intent-aware empty state).
  const [withoutPurposeTotal, setWithoutPurposeTotal] = useState<number | null>(null);
  const [propertyNextCursor, setPropertyNextCursor] = useState<any[] | null>(null);
  const [projectNextCursor, setProjectNextCursor] = useState<any[] | null>(null);
  const [hasMoreProperties, setHasMoreProperties] = useState(false);
  const [hasMoreProjects, setHasMoreProjects] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sortedResultOrder, setSortedResultOrder] = useState<{ type: 'property' | 'project'; id: string }[]>([]);
  const [combinedNextCursor, setCombinedNextCursor] = useState<any[] | null>(null);

  const [boundaryPoints, setBoundaryPoints] = useState<{ lat: number; lng: number }[]>([]);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [boundaryActive, setBoundaryActive] = useState(false);
  // Label for the active non-state boundary (geocoded locality name or the
  // freehand marker). Surfaces in the single map-overlay boundary control so
  // switching locations updates the chip text.
  const [activeBoundaryLabel, setActiveBoundaryLabel] = useState<string | null>(null);
  // Interactive state/emirate selection. The server resolves the id to the
  // bundled boundary, so the client only carries id/name here (no geometry in
  // URLs or cache keys).
  const [selectedState, setSelectedState] = useState<{ id: string; name: string } | null>(null);
  const boundarySourceRef = useRef<maplibregl.GeoJSONSource | null>(null);
  const isDrawingRef = useRef(false);
  const drawPointsRef = useRef<{ lat: number; lng: number }[]>([]);
  // Exact-ring boundary of the selected geocoded entity (ALL outer rings —
  // mainland plus islands). Single source of truth for draw + filter so the
  // outline and the results can never disagree. Freehand drawing keeps using
  // drawPointsRef/boundaryPoints (single flat ring).
  const geocodedRingsRef = useRef<BoundaryRings | null>(null);
  const isDrawingModeRef = useRef(false);
  const boundaryActiveRef = useRef(false);
  const updateBoundaryLayerRef = useRef<(points: { lat: number; lng: number }[] | BoundaryRings, isActive?: boolean) => void>(() => {});

  const fetchPropertiesRef = useRef<typeof fetchAllProperties>(() => Promise.resolve());
  const searchAsIMoveRef = useRef(searchAsIMove);
  const searchScopeRef = useRef(searchScope);
  const intentRef = useRef<Intent>(intent);
  const fullScreenResultsRef = useRef(fullScreenResults);
  const selectedStateRef = useRef(selectedState);
  // Zoom-tier flag: below overviewMaxZoom the map shows state outlines only and
  // the server skips marker generation entirely (markers=false).
  const overviewModeRef = useRef(false);
  // Admin-1 GeoJSON (fetched once from /geo/<file>); layers are (re)built from it.
  const adminGeoRef = useRef<any>(null);
  const stateHoverRef = useRef<string | null>(null);
  // Canonical MapTiler geometry per state (id → FeatureCollection), fetched on
  // hover/selection from /api/admin-geo?state=<ID>&v=<sha> and reused for both.
  // The sha cache-busts across deploys; the pending map dedupes concurrent
  // hover/select/prefetch requests for the same state.
  const stateGeoCacheRef = useRef<Map<string, any>>(new Map());
  const stateGeoPendingRef = useRef<Map<string, Promise<any | null>>>(new Map());
  // Locality polygons from OSM (server-cached); session memory avoids repeat
  // route calls when the same search result is clicked/typed again. Null is a
  // valid cached answer ("no precise boundary") — it prevents retry storms for
  // localities without geometry.
  const placeGeoCacheRef = useRef<Map<string, { rings: BoundaryRings; bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } } | null>>(new Map());
  // Id whose canonical geometry is currently drawn as the hover fill — guards
  // against re-setting a megabyte-scale GeoJSON source on every mousemove.
  const stateHoverDetailRef = useRef<string | null>(null);
  const statePrefetchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const markerHoverRef = useRef(false);
  const stateCountAbortRef = useRef<AbortController | null>(null);
  const stateCountTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const zoomTierTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Hover count cache keyed by state id; cleared when filters/scope/intent
  // change so a count can never describe a stale population.
  const stateCountCacheRef = useRef<Record<string, string>>({});
  // Map-effect callbacks published to the rest of the component (the map
  // lifecycle effect runs once, before the selection helpers are defined).
  const selectStateRef = useRef<(id: string, name: string, bbox: [number, number, number, number]) => void>(() => {});
  const ensureAdminLayersRef = useRef<(() => void) | null>(null);
  const applyAdminTierRef = useRef<(() => void) | null>(null);
  const lookupMapsRef = useRef({ bhkIdToLabel: {} as Record<number, string>, propTypeIdToName: {} as Record<number, string> });
  const fetchIdRef = useRef(0);
  const initialMoveEndRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);
  const autocompleteReqIdRef = useRef(0);  // A5: stale-response guard for autocomplete
  // Latest suggestion list (with ids/place_type/bbox) — the point-place
  // fallback resolves admin areas from THESE visible rows, never a fresh
  // text query (whose candidates differ).
  const suggestionListRef = useRef<AutocompleteSuggestion[]>([]);
  const filtersRef = useRef(filters);

  // Sidebar-hover → map highlight (fetch-free; hover renders card data only).
  const hoveredIdRef = useRef<{ id: string; type: 'property' | 'project' } | null>(null);
  // Click-response cache: full listing details with gallery (filled by click
  // fetches only — hover never touches the network or this cache's fill path).
  const markerCacheRef = useRef(new MarkerLruCache(100));
  // Marker click → rich listing card: stale-response guard
  const clickReqIdRef = useRef(0);
  // MapLibre fires the map-level 'click' even when a point layer was clicked
  // (originalEvent.stopPropagation can't stop synthetic dispatch), so pin
  // clicks set this window during which the background-click closer stands down.
  const suppressMapClickUntil = useRef(0);

  searchAsIMoveRef.current = searchAsIMove;
  searchScopeRef.current = searchScope;
  intentRef.current = intent;
  sortByRef.current = sortBy;
  fullScreenResultsRef.current = fullScreenResults;
  isDrawingModeRef.current = isDrawingMode;
  boundaryActiveRef.current = boundaryActive;
  selectedStateRef.current = selectedState;

  // A6: Sync filtersRef after render (not during render) — prevents stale reads
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    lookupMapsRef.current = lookupMaps;
  }, [lookupMaps]);

  // Canonical region geometry, fetched once per id per session (memory + HTTP
  // immutable caches). Never rejects: a failed fetch degrades to the overview
  // hover/outline that is already drawn, and a later hover retries.
  const fetchStateDetail = useCallback((id: string, sha?: string | null): Promise<any | null> => {
    const cached = stateGeoCacheRef.current.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = stateGeoPendingRef.current.get(id);
    if (pending) return pending;
    const url = `/api/admin-geo?state=${encodeURIComponent(id)}${sha ? `&v=${encodeURIComponent(sha)}` : ''}`;
    const p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((geo) => {
        const fc = geo?.features?.length ? geo : null;
        if (fc) stateGeoCacheRef.current.set(id, fc);
        return fc;
      })
      .catch(() => null)
      .finally(() => {
        stateGeoPendingRef.current.delete(id);
      });
    stateGeoPendingRef.current.set(id, p);
    return p;
  }, []);

  // Locality geometry via the OSM resolver, memoized per text+center. Returns
  // null when no validated polygon exists; callers then recenter without an
  // outline (a bbox rectangle is never drawn — it is not a boundary).
  const resolvePlaceGeometryOSM = useCallback(async (text: string, center?: [number, number] | null) => {
    if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) return null;
    const key = `${text.trim().toLowerCase()}|${center[0].toFixed(3)},${center[1].toFixed(3)}`;
    const cached = placeGeoCacheRef.current.get(key);
    if (cached !== undefined) return cached;
    const result = await fetchPlaceGeometryFromOSM(text, center);
    placeGeoCacheRef.current.set(key, result);
    return result;
  }, []);

  // Admin-1 boundaries: one static tenant asset fetched once (gzipped by the
  // API route); the same file the server resolves ?state= against, so outline
  // and filter cannot drift.
  useEffect(() => {
    if (!ADMIN1) return;
    let cancelled = false;
    fetch('/api/admin-geo')
      .then((r) => (r.ok ? r.json() : null))
      .then((geo) => {
        if (cancelled || !geo) return;
        adminGeoRef.current = geo;
        ensureAdminLayersRef.current?.();
      })
      .catch(() => { /* state layer is progressive enhancement — never block the map */ });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hover counts describe "current filters"; any filter/scope/intent/sort change
  // invalidates the client-side label cache (the server-side count cache is
  // keyed by the filter population and handles its own reuse).
  useEffect(() => {
    stateCountCacheRef.current = {};
  }, [filters, searchScope, intent, sortBy]);

  // A5: Cancel any in-flight autocomplete request + pending debounce
  const cancelAutocomplete = useCallback(() => {
    if (autocompleteAbortRef.current) autocompleteAbortRef.current.abort();
    autocompleteAbortRef.current = null;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = undefined;
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (autocompleteRef.current && !autocompleteRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLocationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setFilters(prev => ({ ...prev, location: value }));
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    // Fire from 2 chars (server floor) so short prefixes suggest instantly.
    if (value.trim().length >= 2) {
      debounceTimer.current = setTimeout(async () => {
        if (autocompleteAbortRef.current) autocompleteAbortRef.current.abort();
        const controller = new AbortController();
        autocompleteAbortRef.current = controller;
        const reqId = ++autocompleteReqIdRef.current;
        try {
          // Proximity = live map center: nearby places rank first without
          // hard-filtering far matches (bias, not bounds).
          const center = mapRef.current?.getCenter();
          const proximity =
            center && Number.isFinite(center.lng) && Number.isFinite(center.lat)
              ? `${center.lng},${center.lat}`
              : undefined;
          const result = await autocompleteSearch(value, controller.signal, searchScopeRef.current, tenant.map.geocodeCountries || undefined, proximity);
          // A5: ignore stale responses — only apply if this is the latest request
          if (reqId !== autocompleteReqIdRef.current) return;
          if (result?.suggestions) {
            setSuggestions(result.suggestions);
            suggestionListRef.current = result.suggestions;
            setShowSuggestions(result.suggestions.length > 0);
          }
        } catch (err) {
          if (err instanceof DOMException && err.name !== 'AbortError') {
            console.error('Autocomplete failed:', err.message);
          }
        }
      }, 350);
    } else {
      // A5: fully reset autocomplete state on clear/short input
      cancelAutocomplete();
      setShowSuggestions(false);
      setSuggestions([]);
    }
  };

  const selectSuggestion = async (suggestion: string | AutocompleteSuggestion) => {
    // A5: cancel any in-flight autocomplete + pending debounce before selecting
    cancelAutocomplete();
    const text = typeof suggestion === 'string' ? suggestion : suggestion.text;
    setFilters(prev => ({ ...prev, location: text }));
    setShowSuggestions(false);
    setSuggestions([]);

    const sug = typeof suggestion === 'object' ? suggestion : null;
    const sugBbox =
      sug?.bbox && sug.bbox.length === 4
        ? { minLng: sug.bbox[0], minLat: sug.bbox[1], maxLng: sug.bbox[2], maxLat: sug.bbox[3] }
        : null;

    if (sug && sug.type === 'geocoded' && sug.id) {
      // Exact-entity geometry by feature id — never a fresh text query's first
      // result, so the outline can't belong to a different place than clicked.
      // ALL outer rings are kept (mainland + islands); an explicitly selected
      // island filters by its own ring.
      try {
        const rings = await fetchGeometryById(sug.id);
        if (rings.length > 0) {
          const bounds = sugBbox ?? {
            minLat: Math.min(...rings.flat().map(p => p.lat)),
            maxLat: Math.max(...rings.flat().map(p => p.lat)),
            minLng: Math.min(...rings.flat().map(p => p.lng)),
            maxLng: Math.max(...rings.flat().map(p => p.lng)),
          };
          applyGeocodedBoundary(rings, bounds, text);
          handleApplyFiltersWithLocation(text, { rings, bbox: bounds });
          return;
        }
        // City `place` entities often have no polygon of their own (Point
        // geometry + degenerate bbox). Resolve the matching administrative
        // areas from the visible suggestion list (e.g. Mumbai → City +
        // Suburban districts) and outline + filter by their exact rings.
        const admin = await resolveAdminBoundary(text, suggestionListRef.current);
        if (admin) {
          applyGeocodedBoundary(admin.rings, admin.bbox, text);
          handleApplyFiltersWithLocation(text, { rings: admin.rings, bbox: admin.bbox });
          return;
        }
        // MapTiler returns centroids for neighborhoods/cities (Point/MultiPoint
        // lookups) — the real locality polygon comes from OSM via the server
        // resolver, which only accepts a polygon the searched point is inside.
        const place = await resolvePlaceGeometryOSM(text, sug.center as [number, number] | undefined);
        if (place) {
          applyGeocodedBoundary(place.rings, place.bbox, text);
          handleApplyFiltersWithLocation(text, { rings: place.rings, bbox: place.bbox });
          return;
        }
      } catch {}
      // No polygon anywhere → center-only handling below. A bounding box is
      // never drawn as a boundary.
    }

    {
      // Center-only (or degenerate point-bbox, e.g. city `place` entries):
      // bounds box around the point, and clear any stale outline/rings so a
      // previous boundary can't keep filtering the new search. The state
      // selection is dropped too — a location search is a boundary selection
      // and must not leave the old state outline standing in for it.
      const center = sug?.center ?? (sugBbox ? [(sugBbox.minLng + sugBbox.maxLng) / 2, (sugBbox.minLat + sugBbox.maxLat) / 2] : null);
      if (center) {
        resetStateSelection();
        clearBoundaryState();
        const [lng, lat] = center;
        geocodedBoundsRef.current = { minLat: lat - 0.1, maxLat: lat + 0.1, minLng: lng - 0.1, maxLng: lng + 0.1 };
        mapRef.current?.flyTo({ center: [lng, lat], zoom: 13, essential: true });
        handleApplyFiltersWithLocation(text, { rings: null, bbox: geocodedBoundsRef.current });
        return;
      }
    }

    // Text-only suggestion (ES property/project/location name): no geography —
    // clear stale boundary and let the text query (+ its own geocode fallback) run.
    clearBoundaryState();
    handleApplyFiltersWithLocation(text);
  };

  const projectSortForBrowse = (sort: SortOption): string => {
    if (sort === 'popular') return 'relevance';
    if (sort === 'newest') return 'date_desc';
    if (sort === 'price_asc') return 'price_asc';
    if (sort === 'price_desc') return 'price_desc';
    return 'relevance';
  };

  // stateOverride: undefined → use the current selection; explicit null → force
  // no state (clearing). The id travels to the server, which resolves it to the
  // same bundled boundary the outline renders.
  const fetchAllProperties = useCallback(async (bounds: LngLatBounds | null, cursorOverride?: { propertyCursor?: any[] | null; projectCursor?: any[] | null; append?: boolean }, polygonOverride?: BoundaryRings | null, stateOverride?: string | null) => {
    // Cancel-on-new: the latest request represents the viewport we actually
    // need, so any in-flight request is aborted immediately instead of being
    // queued. Aborted requests fail with AbortError and are a silent no-op,
    // so stale responses can never paint the map or the sidebar list.
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    const fetchId = ++fetchIdRef.current;
    const isAppend = cursorOverride?.append ?? false;
    // Paint density dots from a markers array (shared by full + tiles modes).
    const paintMarkers = (map: maplibregl.Map, markers: any[]) => {
      const mapFeatures: GeoJSON.Feature[] = [];
      // Top-5 densest cells get numeric count labels (marker-count layer);
      // all other dots render label-free with heat-shaded color. Ranked by
      // grid-cell count desc, deterministic tiebreak on id.
      const rankedForLabels = [...markers]
        .filter((m: any) => m.lat != null && m.lon != null)
        .sort((a: any, b: any) => {
          const ca = typeof a._cellCount === 'number' ? a._cellCount : 1;
          const cb = typeof b._cellCount === 'number' ? b._cellCount : 1;
          if (cb !== ca) return cb - ca;
          return String(a.id).localeCompare(String(b.id));
        })
        .slice(0, 5);
      const topCellIds = new Set(rankedForLabels.map((m: any) => `${m.entity_type || ''}:${m.id}`));
      const formatCount = (n: number): string => {
        if (!Number.isFinite(n) || n <= 1) return '';
        if (n >= 1000000) {
          const v = n / 1000000;
          return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
        }
        if (n >= 1000) {
          const v = n / 1000;
          return `${Number.isInteger(v) ? v : v.toFixed(1)}K`;
        }
        return `${n}`;
      };
      for (const m of markers) {
        if (m.lat == null || m.lon == null) continue;
        const isProject = m.entity_type === 'project';
        const cellCount = typeof m._cellCount === 'number' && m._cellCount > 1 ? Math.round(m._cellCount) : 1;
        mapFeatures.push({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [m.lon, m.lat] },
          properties: {
            id: m.id,
            type: isProject ? 'project' : 'property',
            title: m.title || '',
            price: m.price || 0,
            price_label: formatMoneyCompact(
              m.price,
              isProject ? tenant.projectCurrency : tenant.propertyCurrency
            ),
            sort_key: m.price || 0,
            // Grid-cell density badge (tile MAP path): top-5 densest cells show
            // their count (marker-count layer); all other dots are label-free
            // with heat-shaded color. Singles carry count 1 (no badge).
            _cellCount: cellCount,
            count_label: formatCount(cellCount),
            _topCell: topCellIds.has(`${m.entity_type || ''}:${m.id}`),
            image_url: m.image_url || null,
            bhk_type: m.bhk_type || null,
            bathrooms: m.bathrooms ?? null,
            balconies: m.balconies ?? null,
            furnishing_status: m.furnishing_status || null,
            listing_purpose: m.listing_purpose || null,
            property_type: m.property_type || null,
            area_sqft: m.area_sqft ?? null,
            area_unit: m.area_unit || null,
            location_text: m.location_text || null,
            is_new: !!m.is_new,
            // Click-card preview payload (renders the final card instantly —
            // no content fetch needed; the click fetch only tops up photos).
            low_price: m.low_price ?? null,
            high_price: m.high_price ?? null,
            developer_name: m.developer_name || null,
            construction_phase: m.construction_phase || null,
            construction_progress_percent: m.construction_progress_percent ?? null,
            delivery_date: m.delivery_date || null,
            amenities: Array.isArray(m.amenities) ? m.amenities : [],
            amenities_total: typeof m.amenities_total === 'number' ? m.amenities_total : (Array.isArray(m.amenities) ? m.amenities.length : 0),
            bedrooms_list: Array.isArray(m.bedrooms_list) ? m.bedrooms_list : [],
            unit_count: m.unit_count ?? null,
            payment_plan_summary: m.payment_plan_summary || null,
            image_count: typeof m.image_count === 'number' ? m.image_count : null,
          },
        });
      }
      updateSourceData(map, { type: 'FeatureCollection', features: mapFeatures });
      updateCircleRadius(map, map.getZoom());
    };
    if (!isAppend) {
      setLoading(true);
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
    }

    const rawScope = searchScopeRef.current;
    // Defense in depth: rent intent never queries projects even if scope state lags.
    const scope = intentRef.current === 'rent' && rawScope !== 'properties' ? 'properties' : rawScope;
    const isListView = fullScreenResultsRef.current;
    const { bhkIdToLabel, propTypeIdToName } = lookupMaps;
    const activeFilters = filtersRef.current;
    const activeIntent = intentRef.current;
    const activeListingPurpose = intentToListingPurpose(activeIntent);
    const activeStateId = stateOverride === undefined ? (selectedStateRef.current?.id ?? null) : stateOverride;
    // State-overview mode (below the tenant's overview zoom): outlines only —
    // the server skips marker generation entirely (markers=false).
    const overviewMode = !isListView && overviewModeRef.current;
    // Page size: 24 always. Map dots come from the markers array returned by
    // /api/map-data (up to 500 per viewport), not from the 24 list docs here.
    const params: any = { pageSize: 24, sort: sortByRef.current };
    if (activeListingPurpose) params.listingPurpose = activeListingPurpose;

    if (activeFilters.location) params.location = activeFilters.location;
    if (activeFilters.minPrice) params.minPrice = Number(activeFilters.minPrice);
    if (activeFilters.maxPrice) params.maxPrice = Number(activeFilters.maxPrice);
    if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
      params.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
    }
    if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
      params.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
    }

    // Exact-ring boundary wins (geocoded selection); freehand falls back to
    // its flat ring. Sent as `polygons` so every ring filters (mainland AND
    // islands); the server normalizes + caps for ES and cache keys.
    const activeRings: BoundaryRings | null =
      polygonOverride && polygonOverride.length > 0
        ? polygonOverride
        : geocodedRingsRef.current && geocodedRingsRef.current.length > 0
          ? geocodedRingsRef.current
          : boundaryActiveRef.current && boundaryPoints.length >= 3
            ? [boundaryPoints]
            : null;
    if (activeRings && activeRings.length > 0) {
      params.polygons = activeRings;
    }
    if (activeStateId) params.state = activeStateId;
    if (overviewMode) params.markers = false;
    if (searchAsIMoveRef.current && bounds && !isListView) {
      // Clamp viewport bounds to valid coordinate ranges before sending.
      // At very low zooms the viewport can exceed the antimeridian (MapLibre
      // returns e.g. east=291°) — ES rejects longitudes outside ±180 with a
      // 400, which used to surface as an empty map.
      let minLat = Math.max(-85.0511, Math.min(85.0511, bounds.getSouthWest().lat));
      let maxLat = Math.max(-85.0511, Math.min(85.0511, bounds.getNorthEast().lat));
      let minLng = Math.max(-180, Math.min(180, bounds.getSouthWest().lng));
      let maxLng = Math.max(-180, Math.min(180, bounds.getNorthEast().lng));
      if (minLng > maxLng) { minLng = -180; maxLng = 180; } // wrapped across the antimeridian
      if (isFinite(minLat) && isFinite(maxLat) && isFinite(minLng) && isFinite(maxLng)) {
        params.bounds = { minLat, maxLat, minLng, maxLng };
      }
    }

    if (cursorOverride?.propertyCursor && (scope === 'properties' || scope === 'both')) {
      params.cursor = cursorOverride.propertyCursor;
    }

    try {
      if (!isAppend) {
        // FRESH LOAD: combined /api/map-data endpoint queried with the EXACT
        // viewport bounds — one viewport, one query, full-viewport coverage.
        // Never substitute a sub-region (tile) fetch here: that was the
        // one-sided-dots regression.
        const currentZoom = mapRef.current ? Math.round(mapRef.current.getZoom()) : 12;
        const combinedParams: any = {
          bounds: params.bounds,
          zoom: currentZoom,
          scope,
          query: activeFilters.location || undefined,
          minPrice: activeFilters.minPrice ? Number(activeFilters.minPrice) : undefined,
          maxPrice: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : undefined,
          pageSize: 24,
          sort: sortByRef.current,
          ...(activeListingPurpose ? { listingPurpose: activeListingPurpose } : {}),
          // State id stays on GET (URL-safe, CDN-shareable); the server resolves
          // it to the same bundled boundary the outline renders.
          ...(activeStateId ? { state: activeStateId } : {}),
          ...(overviewMode ? { markers: false } : {}),
        };
        if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
          combinedParams.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
        }
        if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
          combinedParams.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
        }
        if (params.polygons) {
          combinedParams.polygons = params.polygons;
        }

        // Prefer GET for the fresh load: POST can never be cached by a CDN, so
        // warm pans otherwise terminate at the origin. GET is URL-identical for
        // the same logical query, so the edge absorbs repeated viewports.
        // Boundaries and cursors stay on POST (rejected by the GET guard rather
        // than silently dropped — a cached response must never ignore a filter).
        let res: Response;
        if (combinedParams.polygons || combinedParams.cursor) {
          res = await fetch('/api/map-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(combinedParams),
            signal,
          });
        } else {
          const qp = new URLSearchParams();
          const b = combinedParams.bounds;
          const z = combinedParams.zoom ?? 10;
          if (b) {
            // Tile-union bounds, not exact viewport: identical URL for anyone
            // covering the same tiles, so the CDN can reuse the response.
            const c = canonicalTileBounds(b, z);
            qp.set('minLat', c.minLat);
            qp.set('maxLat', c.maxLat);
            qp.set('minLng', c.minLng);
            qp.set('maxLng', c.maxLng);
          }
          qp.set('zoom', String(z));
          qp.set('scope', scope);
          qp.set('sort', sortByRef.current);
          qp.set('pageSize', String(combinedParams.pageSize ?? 24));
          for (const k of ['query', 'listingPurpose', 'bhkType', 'propertyType', 'state'] as const) {
            const v = (combinedParams as any)[k];
            if (v != null && v !== '') qp.set(k, String(v));
          }
          for (const k of ['minPrice', 'maxPrice'] as const) {
            const v = (combinedParams as any)[k];
            if (v != null && v !== '') qp.set(k, String(v));
          }
          if (overviewMode) qp.set('markers', 'false');
          res = await fetch(`/api/map-data?${qp.toString()}`, { signal });
        }
        if (fetchId !== fetchIdRef.current) return;
        if (!res.ok) {
          setProperties([]);
          setProjects([]);
        } else {
          const response = await res.json();

          // Process ES listings first (needed for both sidebar AND map markers)
          const props: PropertyBrowse[] = [];
          const projs: ProjectBrowse[] = [];
          const order: { type: 'property' | 'project'; id: string }[] = [];

          for (const r of (response.results || [])) {
            if (r.entity_type === 'property') {
              const mapped = mapEsResultToPropertyCard(r);
              const formatted: PropertyBrowse = {
                ...mapped,
                latitude: r.location?.lat ?? null,
                longitude: r.location?.lon ?? null,
                images: mapped.images.length > 0 ? mapped.images : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }],
              };
              props.push(formatted);
              order.push({ type: 'property', id: r.id });
            } else if (r.entity_type === 'project') {
              const loc = r.location || {};
              const mapped: ProjectBrowse = {
                id: r.id,
                name: r.name || '',
                slug: r.slug || '',
                low_price: r.low_price || 0,
                high_price: r.high_price || 0,
                construction_phase: r.construction_phase || '',
                construction_progress_percent: r.construction_progress_percent ?? null,
                delivery_date: r.delivery_date || null,
                developer_name: r.developer_name || '',
                primary_image: r.image_url || null,
                all_images: Array.isArray(r.all_images)
                  ? [r.image_url, ...r.all_images].filter((u): u is string => typeof u === 'string' && u.length > 0).filter((u, i, arr) => arr.indexOf(u) === i)
                  : (r.image_url ? [r.image_url] : []),
                location_name: r.location_text || null,
                bedrooms_list: Array.isArray(r.bedrooms_list) ? r.bedrooms_list : [],
                unit_count: r.unit_count ?? null,
                payment_plan_summary: r.payment_plan_summary || null,
                amenities: Array.isArray(r.amenities) ? r.amenities.slice(0, 6) : [],
                amenities_total: r.amenities_total ?? (Array.isArray(r.amenities) ? r.amenities.length : 0),
                latitude: loc.lat ?? null,
                longitude: loc.lon ?? null,
              };
              projs.push(mapped);
              order.push({ type: 'project', id: r.id });
            }
          }

          // Build map GeoJSON from the lightweight markers (up to ~500 dots,
          // Zillow-style). Markers come from the SAME filtered population as the
          // sidebar list, so map dots + list + badge stay consistent.
          if (fetchId !== fetchIdRef.current) return;

          // Only the newest response may paint dots on the map.
          if (mapRef.current) {
            paintMarkers(mapRef.current, response.markers || []);
          }

          setProperties(props);
          setProjects(projs);
          setSortedResultOrder(order);
          setPropertyTotal(response.propertyTotal ?? 0);
          setProjectTotal(response.projectTotal ?? 0);
          setTotalRelation(response.totalRelation);
          setMarkerCount((response.markers || []).length);
          setProjectGroups(response.projectGroups || []);
          setCombinedNextCursor(response.nextCursor ?? null);
          setWithoutPurposeTotal(
            typeof response.withoutPurposeTotal === 'number' ? response.withoutPurposeTotal : null
          );

          // AD4: the full-match by_project rollup visits every matching doc, so
          // LAZY_PILLS keeps it OFF the list query (response.projectGroups is
          // therefore empty by design). Pills load here from their own endpoint
          // with its own long-TTL cache — non-blocking, so the map/list paint
          // first. Epoch-guarded: a stale response must not overwrite a newer
          // pan's pills.
          if (combinedParams.bounds) {
            const epoch = fetchId;
            const cb = canonicalTileBounds(combinedParams.bounds, currentZoom);
            const gps = new URLSearchParams({
              minLat: cb.minLat,
              maxLat: cb.maxLat,
              minLng: cb.minLng,
              maxLng: cb.maxLng,
              zoom: String(currentZoom),
              scope,
              sort: sortByRef.current,
            });
            if (combinedParams.query) gps.set('query', combinedParams.query);
            if (combinedParams.listingPurpose) gps.set('listingPurpose', combinedParams.listingPurpose);
            if (combinedParams.minPrice != null) gps.set('minPrice', String(combinedParams.minPrice));
            if (combinedParams.maxPrice != null) gps.set('maxPrice', String(combinedParams.maxPrice));
            if (combinedParams.bhkType) gps.set('bhkType', combinedParams.bhkType);
            if (combinedParams.propertyType) gps.set('propertyType', combinedParams.propertyType);
            // Pills must describe the same population as the list/markers (AD3),
            // so the state filter travels with this request too.
            if (combinedParams.state) gps.set('state', String(combinedParams.state));
            fetch(`/api/project-groups?${gps.toString()}`, { signal })
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => {
                if (j && epoch === fetchIdRef.current) setProjectGroups(j.projectGroups || []);
              })
              .catch(() => { /* pills are decorative; never block on them */ });
          }

          // The location fetch has completed with the correct (geocoded)
          // bounds, so the post-fitBounds moveend can now behave like a normal
          // corrective fetch instead of being suppressed by the guard below.
          geocodedBoundsRef.current = null;
        }
      } else if (scope === 'both' && isAppend) {
        // APPEND: Use existing /api/search endpoint for pagination
        const combinedParams: any = {
          scope: intentRef.current === 'rent' ? 'properties' : 'both',
          query: activeFilters.location || undefined,
          minPrice: activeFilters.minPrice ? Number(activeFilters.minPrice) : undefined,
          maxPrice: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : undefined,
          pageSize: 24,
          sort: sortByRef.current,
          ...(activeListingPurpose ? { listingPurpose: activeListingPurpose } : {}),
          ...(activeStateId ? { state: activeStateId } : {}),
        };
        if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
          combinedParams.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
        }
        if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
          combinedParams.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
        }
        if (params.bounds) combinedParams.bounds = params.bounds;
        // Forward exact-ring boundary to Load More results — without this,
        // paginated results ignore the active boundary
        if (params.polygons) {
          combinedParams.polygons = params.polygons;
        }
        if (cursorOverride?.propertyCursor) {
          combinedParams.cursor = cursorOverride.propertyCursor;
        }

        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(combinedParams),
          signal,
        });
        if (fetchId !== fetchIdRef.current) return;
        if (!res.ok) {
          // No-op for append
        } else {
          const response = await res.json();
          if (fetchId !== fetchIdRef.current) return;
          const props: PropertyBrowse[] = [];
          const projs: ProjectBrowse[] = [];
          const order: { type: 'property' | 'project'; id: string }[] = [];

          for (const r of (response.results || [])) {
            if (r.entity_type === 'property') {
              const mapped = mapEsResultToPropertyCard(r);
              const formatted: PropertyBrowse = {
                ...mapped,
                latitude: r.location?.lat ?? null,
                longitude: r.location?.lon ?? null,
                images: mapped.images.length > 0 ? mapped.images : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }],
              };
              props.push(formatted);
              order.push({ type: 'property', id: r.id });
            } else if (r.entity_type === 'project') {
              const loc = r.location || {};
              const mapped: ProjectBrowse = {
                id: r.id,
                name: r.name || '',
                slug: r.slug || '',
                low_price: r.low_price || 0,
                high_price: r.high_price || 0,
                construction_phase: r.construction_phase || '',
                construction_progress_percent: r.construction_progress_percent ?? null,
                delivery_date: r.delivery_date || null,
                developer_name: r.developer_name || '',
                primary_image: r.image_url || null,
                all_images: Array.isArray(r.all_images)
                  ? [r.image_url, ...r.all_images].filter((u): u is string => typeof u === 'string' && u.length > 0).filter((u, i, arr) => arr.indexOf(u) === i)
                  : (r.image_url ? [r.image_url] : []),
                location_name: r.location_text || null,
                bedrooms_list: Array.isArray(r.bedrooms_list) ? r.bedrooms_list : [],
                unit_count: r.unit_count ?? null,
                payment_plan_summary: r.payment_plan_summary || null,
                amenities: Array.isArray(r.amenities) ? r.amenities.slice(0, 6) : [],
                amenities_total: r.amenities_total ?? (Array.isArray(r.amenities) ? r.amenities.length : 0),
                latitude: loc.lat ?? null,
                longitude: loc.lon ?? null,
              };
              projs.push(mapped);
              order.push({ type: 'project', id: r.id });
            }
          }

          // Cap arrays to prevent unbounded memory growth during infinite scroll
          setProperties(prev => mergeUniqueById(prev, props).slice(-MAX_LIST_ITEMS));
          setProjects(prev => mergeUniqueById(prev, projs).slice(-MAX_LIST_ITEMS));
          setSortedResultOrder(prev => mergeUniqueById(prev, order).slice(-MAX_LIST_ITEMS));
          setPropertyTotal(response.propertyTotal ?? 0);
          setProjectTotal(response.projectTotal ?? 0);
          setCombinedNextCursor(response.nextCursor ?? null);
        }
      } else if (scope === 'projects') {
        const projectParams: any = {
          query: activeFilters.location || undefined,
          minPrice: activeFilters.minPrice ? Number(activeFilters.minPrice) : undefined,
          maxPrice: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : undefined,
          pageSize: isAppend ? 12 : 100,
          sort: projectSortForBrowse(sortByRef.current),
          bounds: params.bounds,
          polygons: params.polygons,
          state: activeStateId || undefined,
          signal,
        };
        if (cursorOverride?.projectCursor) {
          projectParams.cursor = cursorOverride.projectCursor;
        }
        const response = await searchProjects(projectParams);
        if (fetchId !== fetchIdRef.current) return;
        const mapped: ProjectBrowse[] = (response.results || []).map((r: any) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          low_price: r.low_price || 0,
          high_price: r.high_price || 0,
          construction_phase: r.construction_phase || '',
          construction_progress_percent: r.construction_progress_percent ?? null,
          delivery_date: r.delivery_date || null,
          developer_name: r.developer_name || '',
          primary_image: r.primary_image || null,
          all_images: Array.isArray(r.all_images)
            ? [r.primary_image, ...r.all_images].filter((u): u is string => typeof u === 'string' && u.length > 0).filter((u, i, arr) => arr.indexOf(u) === i)
            : (r.primary_image ? [r.primary_image] : []),
          location_name: r.location_name || null,
          bedrooms_list: Array.isArray(r.bedrooms_list) ? r.bedrooms_list : [],
          unit_count: r.unit_count ?? null,
          payment_plan_summary: r.payment_plan_summary || null,
          amenities: Array.isArray(r.amenities) ? r.amenities.slice(0, 6) : [],
          amenities_total: r.amenities_total ?? (Array.isArray(r.amenities) ? r.amenities.length : 0),
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
        }));
        if (isAppend) {
          setProjects(prev => mergeUniqueById(prev, mapped).slice(-MAX_LIST_ITEMS));
        } else {
          setProjects(mapped);
        }
        setProjectTotal(response.total ?? mapped.length);
        setProjectNextCursor(response.nextCursor ?? null);
        setHasMoreProjects(!!response.nextCursor);
        setProperties([]);
        setPropertyTotal(0);
        setSortedResultOrder([]);
        setCombinedNextCursor(null);
      } else {
        const response = await searchProperties(params, signal);
        if (fetchId !== fetchIdRef.current) return;
        if (!response || !response.results) {
          if (!isAppend) setProperties([]);
        } else {
          const mapped = response.results.map((r: any) => mapEsResultToPropertyCard(r));
          const formattedData: PropertyBrowse[] = mapped.map((p: any) => ({
            ...p,
            images: p.images.length > 0 ? p.images : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }],
          }));
          if (isAppend) {
            setProperties(prev => mergeUniqueById(prev, formattedData).slice(-MAX_LIST_ITEMS));
          } else {
            setProperties(formattedData);
          }
          setPropertyTotal(response.total ?? formattedData.length);
          setPropertyNextCursor(response.nextCursor ?? null);
          setHasMoreProperties(!!response.nextCursor);
        }

        if (!isAppend) {
          setProjects([]);
          setProjectTotal(0);
          setHasMoreProjects(false);
          setProjectNextCursor(null);
        }
        setSortedResultOrder([]);
        setCombinedNextCursor(null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (fetchId === fetchIdRef.current) {
        if (!isAppend) {
          setProperties([]);
          setProjects([]);
          setProjectTotal(0);
          setPropertyTotal(0);
        }
      }
    } finally {
      // Keep abortRef pointing at the newest controller; if a newer request
      // started, its own finally will clear it.
      if (abortRef.current === controller) abortRef.current = null;
    }
    if (fetchId === fetchIdRef.current) {
      if (isAppend) setLoadingMore(false);
      else setLoading(false);
    }
  }, [filters, lookupMaps, boundaryActive, boundaryPoints]);

  fetchPropertiesRef.current = fetchAllProperties;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Pin a dot at a listing's coordinates (used by sidebar hover). The dedicated
  // highlight source survives every browse-points overwrite, and explicit
  // coordinates mean we can pin listings whose marker isn't currently rendered.
  const applyHoverMarker = useCallback((data: {
    id: string;
    type: 'property' | 'project';
    lat: number;
    lon: number;
    title?: string;
    price?: number;
    image?: string;
    location?: string;
  }) => {
    const map = mapRef.current;
    if (!map || fullScreenResultsRef.current) return;
    // The price label is rendered by the highlight's own symbol layer, so it
    // stays locked to the bubble at every zoom/pan (never detaches or clips).
    setHighlightedPoint(map, { ...data, price_label: formatHighlightPrice(data.type, data.price) });
    // Hide the listing's base dot so the bubble reads as one clean unit.
    setHighlightState(map, data.id);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (abortRef.current) abortRef.current.abort();
      if (autocompleteAbortRef.current) autocompleteAbortRef.current.abort();
    };
  }, []);

  const propertyMap = useMemo(() => new Map(properties.map(p => [p.id, p])), [properties]);
  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);

  // Sidebar card hover → highlight its marker. Rendered strictly from the card's
  // own data (which the list already holds) — hover NEVER fetches. Cards without
  // coordinates simply skip the highlight.
  const handleCardHover = useCallback((data: {
    id: string;
    type: 'property' | 'project';
    lat: number | null;
    lon: number | null;
    title?: string;
    price?: number;
    image?: string;
    location?: string;
  }) => {
    hoveredIdRef.current = { id: data.id, type: data.type };
    if (data.lat == null || data.lon == null) return;
    applyHoverMarker({
      id: data.id,
      type: data.type,
      lat: data.lat,
      lon: data.lon,
      title: data.title,
      price: data.price,
      image: data.image,
      location: data.location,
    });
  }, [applyHoverMarker]);

  const handleCardLeave = useCallback(() => {
    hoveredIdRef.current = null;
    if (mapRef.current) {
      setHighlightedPoint(mapRef.current, null);
      setHighlightState(mapRef.current, null);
    }
  }, []);

  const combinedList = useMemo(() => {
    if (searchScope === 'both') {
      return [...properties.map(p => ({ type: 'property' as const, data: p })), ...projects.map(p => ({ type: 'project' as const, data: p }))];
    }
    if (searchScope === 'projects') return projects.map(p => ({ type: 'project' as const, data: p }));
    return properties.map(p => ({ type: 'property' as const, data: p }));
  }, [properties, projects, searchScope]);

  useEffect(() => {
    const init = async () => {
      const [bhkData, propTypeData] = await Promise.all([
        getLookup('bhk_types'), getLookup('property_types'),
      ]);
      setBhkTypes(bhkData);
      setPropertyTypes(propTypeData);
      setLookupMaps({
        bhkIdToLabel: Object.fromEntries(bhkData.map((b: any) => [b.id, b.label])),
        propTypeIdToName: Object.fromEntries(propTypeData.map((p: any) => [p.id, p.name])),
      });
    };
    init();
  }, []);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current || !process.env.NEXT_PUBLIC_MAPTILER_KEY) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`,
      center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM,
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== 'production') (window as any).__map = map; // dev-only debug hook
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    // ---- Interactive state/emirate selection (admin-1) --------------------
    // Marker layers are hidden in overview mode so the country view is state
    // outlines only; the server is also told markers=false in that mode.
    const ADMIN_MARKER_LAYER_IDS = [
      'unclustered-properties-halo',
      'unclustered-projects-halo',
      'unclustered-properties',
      'unclustered-projects',
      'marker-price',
      'marker-count',
    ];
    const computeTier = (zoom: number): 'overview' | 'outline' | 'city' => {
      if (!ADMIN1) return 'city';
      if (zoom < ADMIN1.overviewMaxZoom) return 'overview';
      if (zoom <= ADMIN1.outlineMaxZoom) return 'outline';
      return 'city';
    };
    // Drop every trace of state hover (feature states, canonical hover
    // geometry, tooltip, pending counts, cursor). Used on pointer leave AND
    // when zoom crosses out of the state-interaction band, so a stationary
    // pointer cannot leave a stale highlight behind.
    function clearStateHover() {
      if (stateHoverRef.current != null) {
        clearAdminHover(map, stateHoverRef.current);
        setAdminDetailState(map, null, stateHoverRef.current);
        stateHoverRef.current = null;
      }
      stateHoverDetailRef.current = null;
      setHoverDetail(map, null);
      setOverviewHoverExcluded(map, null);
      hideStateTooltip();
      if (stateCountTimerRef.current) clearTimeout(stateCountTimerRef.current);
      if (stateCountAbortRef.current) stateCountAbortRef.current.abort();
      if (!markerHoverRef.current) map.getCanvas().style.cursor = '';
    }
    const applyTierForZoom = () => {
      if (!ADMIN1) return;
      const tier = computeTier(map.getZoom());
      overviewModeRef.current = tier === 'overview';
      // Above outlineMaxZoom the hit surface is hidden: leave no hover behind
      // when the threshold is crossed while the pointer rests on a state.
      if (tier === 'city') clearStateHover();
      applyAdminTier(map, tier, !!selectedStateRef.current);
      const visible = tier !== 'overview';
      for (const id of ADMIN_MARKER_LAYER_IDS) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
    };
    applyAdminTierRef.current = applyTierForZoom;

    const ensureAdminLayers = () => {
      if (!ADMIN1 || !adminGeoRef.current) return;
      // Admin layers are inserted beneath the marker layers so dots stay on top
      // and a visible marker keeps its click priority over the state fill.
      const beforeId = map.getLayer('unclustered-properties')
        ? 'unclustered-properties'
        : map.getLayer('unclustered-properties-halo')
          ? 'unclustered-properties-halo'
          : undefined;
      setupAdminLayers(map, adminGeoRef.current, beforeId);
      applyTierForZoom();
    };
    ensureAdminLayersRef.current = ensureAdminLayers;

    // Hover counts are lazy (one cached count per state x filter population),
    // debounced and aborted on leave so a fast pointer sweep never queues
    // queries for states the user didn't dwell on.
    const fetchStateCount = (id: string, name: string, point: { x: number; y: number }, immediate = false) => {
      if (!ADMIN1?.showCounts) return;
      const cached = stateCountCacheRef.current[id];
      if (cached) {
        if (stateHoverRef.current === id) showStateTooltip(map, point, name, cached);
        return;
      }
      if (stateCountTimerRef.current) clearTimeout(stateCountTimerRef.current);
      const run = async () => {
        if (stateCountAbortRef.current) stateCountAbortRef.current.abort();
        const ctrl = new AbortController();
        stateCountAbortRef.current = ctrl;
        try {
          const gps = new URLSearchParams({ state: id, scope: searchScopeRef.current });
          const f = filtersRef.current;
          const { bhkIdToLabel, propTypeIdToName } = lookupMapsRef.current;
          if (f.location) gps.set('query', f.location);
          if (f.minPrice) gps.set('minPrice', f.minPrice);
          if (f.maxPrice) gps.set('maxPrice', f.maxPrice);
          if (f.bhkTypeId && bhkIdToLabel[Number(f.bhkTypeId)]) gps.set('bhkType', bhkIdToLabel[Number(f.bhkTypeId)]);
          if (f.propertyTypeId && propTypeIdToName[Number(f.propertyTypeId)]) gps.set('propertyType', propTypeIdToName[Number(f.propertyTypeId)]);
          const purpose = intentToListingPurpose(intentRef.current);
          if (purpose) gps.set('listingPurpose', purpose);
          const res = await fetch(`/api/state-counts?${gps.toString()}`, { signal: ctrl.signal });
          if (!res.ok) return;
          const j = await res.json();
          if (typeof j?.total !== 'number') return;
          const label = `${j.total.toLocaleString()} ${j.total === 1 ? 'listing' : 'listings'}`;
          stateCountCacheRef.current[id] = label;
          if (stateHoverRef.current === id) showStateTooltip(map, point, name, label);
        } catch { /* aborted or offline — the tooltip keeps the name only */ }
      };
      if (immediate) void run();
      else stateCountTimerRef.current = setTimeout(run, 150);
    };

    const onStateMouseMove = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      if (!ADMIN1 || isDrawingModeRef.current || isDrawingRef.current) return;
      // Above outlineMaxZoom state interaction is off; this covers events
      // already in flight when the tier flipped.
      if (computeTier(map.getZoom()) === 'city') return;
      const feature = e.features?.[0];
      if (!feature) return;
      const id = String((feature as any).id ?? (feature.properties as any)?.id ?? '');
      const name = String((feature.properties as any)?.name || id);
      if (!id) return;
      if (stateHoverRef.current !== id) {
        clearAdminHover(map, stateHoverRef.current);
        setAdminDetailState(map, null, stateHoverRef.current);
        setAdminHover(map, id);
        stateHoverRef.current = id;
      }
      map.getCanvas().style.cursor = 'pointer';
      const cachedLabel = stateCountCacheRef.current[id] ?? null;
      showStateTooltip(map, e.point, name, cachedLabel);
      if (!cachedLabel) fetchStateCount(id, name, e.point);
      // Upgrade the coarse overview hover to the exact MapTiler shape as soon
      // as the canonical geometry is available (usually instant after first
      // hover/prefetch, one gzipped fetch otherwise). Guarded by the applied-id
      // ref: re-setting the source on every mousemove re-parses the full
      // geometry and freezes the render loop.
      if (stateHoverDetailRef.current !== id) {
        const sha = typeof (feature.properties as any)?.sha === 'string' ? (feature.properties as any).sha : null;
        fetchStateDetail(id, sha).then((fc) => {
          if (!fc || stateHoverRef.current !== id || mapRef.current !== map) return;
          if (stateHoverDetailRef.current === id) return;
          stateHoverDetailRef.current = id;
          setHoverDetail(map, fc);
          setOverviewHoverExcluded(map, id);
          setAdminDetailState(map, id);
        });
      }
    };

    const onStateMouseLeave = () => clearStateHover();

    // MapLibre serializes non-string feature properties — arrays arrive as
    // JSON strings in event features (same reason onPointClick parses
    // `props.amenities`). Accept both shapes so the click can never depend on
    // the serialization detail.
    const parseBbox = (raw: unknown): [number, number, number, number] | null => {
      let value: unknown = raw;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return null; }
      }
      if (!Array.isArray(value) || value.length !== 4) return null;
      const nums = value.map(Number);
      if (!nums.every((n) => Number.isFinite(n))) return null;
      return nums as [number, number, number, number];
    };

    const onStateClick = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      if (!ADMIN1 || isDrawingModeRef.current || isDrawingRef.current) return;
      // Above outlineMaxZoom click-to-select is off (hit surface hidden).
      if (computeTier(map.getZoom()) === 'city') return;
      // A marker click wins the press (its handler opened the suppression window).
      if (Date.now() < suppressMapClickUntil.current) return;
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties as any;
      const id = String((feature as any).id ?? props?.id ?? '');
      const bbox = parseBbox(props?.bbox);
      if (!id || !bbox) return;
      e.originalEvent?.stopPropagation?.();
      suppressMapClickUntil.current = Date.now() + 350;
      hideStateTooltip();
      selectStateRef.current(id, String(props?.name || id), bbox);
    };

    // Idle prefetch: warm canonical geometry for up to two visible states so
    // the first hover in the outline band renders exact without waiting on the
    // network. Sequential, saveData-aware, never on the overview tier.
    const scheduleStatePrefetch = () => {
      if (statePrefetchTimerRef.current) clearTimeout(statePrefetchTimerRef.current);
      if ((navigator as any).connection?.saveData) return;
      statePrefetchTimerRef.current = setTimeout(() => {
        if (mapRef.current !== map || overviewModeRef.current) return;
        const geo = adminGeoRef.current;
        if (!geo) return;
        const b = map.getBounds();
        const vp = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        const picks = (geo.features || [])
          .filter((f: any) => {
            const bb = parseBbox(f?.properties?.bbox);
            return bb !== null && !(bb[2] < vp[0] || bb[0] > vp[2] || bb[3] < vp[1] || bb[1] > vp[3]);
          })
          .filter((f: any) => !stateGeoCacheRef.current.has(String(f.id)))
          .slice(0, 2);
        let chain: Promise<unknown> = Promise.resolve();
        for (const f of picks) {
          const id = String(f.id);
          const sha = typeof f?.properties?.sha === 'string' ? f.properties.sha : null;
          chain = chain.then(() => fetchStateDetail(id, sha));
        }
      }, 400);
    };

    const onZoomEnd = () => {
      if (!ADMIN1) return;
      const wasOverview = overviewModeRef.current;
      applyTierForZoom();
      // Crossing the overview threshold changes the request shape itself
      // (markers=false), so refetch even when search-as-I-move is off.
      if (wasOverview !== overviewModeRef.current && !isDrawingModeRef.current) {
        if (zoomTierTimerRef.current) clearTimeout(zoomTierTimerRef.current);
        zoomTierTimerRef.current = setTimeout(() => fetchPropertiesRef.current(map.getBounds()), 250);
      }
      if (!overviewModeRef.current && !isDrawingModeRef.current) scheduleStatePrefetch();
    };

    const onPointMouseMove = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties as any;
      markerHoverRef.current = true;
      map.getCanvas().style.cursor = 'pointer';
      const point: ClusterPoint = {
        id: props.id, type: props.type, title: props.title, price: props.price || 0,
        latitude: e.lngLat.lat, longitude: e.lngLat.lng,
        image_url: props.image_url ?? null,
        bhk_type: props.bhk_type ?? null,
        bathrooms: props.bathrooms ?? null,
        balconies: props.balconies ?? null,
        furnishing_status: props.furnishing_status ?? null,
        listing_purpose: props.listing_purpose ?? null,
        area_sqft: props.area_sqft ?? null,
        area_unit: props.area_unit ?? null,
        location_text: props.location_text ?? null,
        is_new: !!props.is_new,
      };
      showPropertyPreview(map, point, e.lngLat);
    };

    const onPointMouseLeave = () => {
      markerHoverRef.current = false;
      // Leave the pointer cursor alone when the pointer is still over a state
      // fill (both layers can be under the cursor at the same time).
      if (!stateHoverRef.current) map.getCanvas().style.cursor = '';
      hidePropertyPreview();
    };

    const onPointClick = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties as any;
      if (!props?.id) return;
      // Don't let the click bubble to the map's background-click close handler.
      e.originalEvent?.stopPropagation?.();
      // Belt-and-braces: MapLibre dispatches layer clicks AND the map click for
      // the same press (proven in-browser), so the background closer below
      // stands down briefly for every pin click.
      suppressMapClickUntil.current = Date.now() + 350;

      const map = mapRef.current;
      if (!map) return;
      // MapLibre reuses the event object, so capture the marker's coordinates
      // NOW — the async fetch below must not read `e.lngLat` later.
      const geom = feature.geometry as GeoJSON.Point | undefined;
      const pointLngLat = geom?.coordinates
        ? new maplibregl.LngLat(geom.coordinates[0], geom.coordinates[1])
        : e.lngLat;

      const reqId = ++clickReqIdRef.current;
      const isProject = props.type === 'project';
      // MapLibre stringifies array props — parse back before rendering.
      const tileAmenities = tileStringArray(props.amenities);
      const tileAmenitiesTotal = typeof props.amenities_total === 'number'
        ? props.amenities_total
        : tileAmenities.length;
      const tileBeds = tileNumberArray(props.bedrooms_list);
      // Instant FINAL card from tile data: markers now carry the complete
      // preview payload (amenities, price range, project extras), so this
      // first paint already has final size/layout. The fetch below only tops
      // up the photo gallery (overlay-only, zero reflow).
      showListingPreviewCard(map, {
        id: props.id,
        entity_type: isProject ? 'project' : 'property',
        lat: pointLngLat.lat,
        lon: pointLngLat.lng,
        title: props.title || '',
        price: isProject ? 0 : (props.price || 0),
        low_price: isProject ? (props.low_price ?? props.price ?? 0) : null,
        high_price: isProject ? (props.high_price ?? null) : null,
        image_url: props.image_url || null,
        location_text: props.location_text || null,
        area_sqft: props.area_sqft ?? null,
        area_unit: props.area_unit || null,
        bhk_type: props.bhk_type || null,
        bathrooms: props.bathrooms ?? null,
        balconies: props.balconies ?? null,
        furnishing_status: props.furnishing_status || null,
        listing_purpose: props.listing_purpose || null,
        property_type: props.property_type || null,
        developer_name: props.developer_name || null,
        construction_phase: props.construction_phase || null,
        construction_progress_percent: props.construction_progress_percent ?? null,
        delivery_date: props.delivery_date || null,
        amenities: tileAmenities,
        amenities_total: tileAmenitiesTotal,
        bedrooms_list: tileBeds,
        unit_count: props.unit_count ?? null,
        payment_plan_summary: props.payment_plan_summary || null,
      }, pointLngLat);

      // Click-response cache: second click on the same marker skips the fetch.
      const clickKey = `${props.type}:${props.id}`;
      const clickCached = markerCacheRef.current.get(clickKey);
      if (clickCached?.all_images && clickCached.all_images.length > 0) {
          showListingPreviewCard(map, {
          id: clickCached.id,
          entity_type: clickCached.type,
          lat: pointLngLat.lat,
          lon: pointLngLat.lng,
          title: clickCached.title || '',
          price: clickCached.price || 0,
          low_price: clickCached.low_price ?? null,
          high_price: clickCached.high_price ?? null,
          image_url: clickCached.image || null,
          all_images: clickCached.all_images,
          location_text: clickCached.location_text || clickCached.location || null,
          area_sqft: clickCached.area_sqft ?? null,
          area_unit: clickCached.area_unit || null,
          bhk_type: clickCached.bhk_type || null,
          bathrooms: clickCached.bathrooms ?? null,
          balconies: clickCached.balconies ?? null,
          furnishing_status: clickCached.furnishing_status || null,
          listing_purpose: clickCached.listing_purpose || null,
          property_type: clickCached.property_type || null,
          developer_name: clickCached.developer_name || null,
          construction_phase: clickCached.construction_phase || null,
          delivery_date: clickCached.delivery_date || null,
          amenities: clickCached.amenities || [],
          amenities_total: clickCached.amenities_total ?? (clickCached.amenities || []).length,
          bedrooms_list: clickCached.bedrooms_list || [],
          unit_count: clickCached.unit_count ?? null,
          payment_plan_summary: clickCached.payment_plan_summary || null,
          construction_progress_percent: clickCached.construction_progress_percent ?? null,
        }, pointLngLat);
        return;
      }

      // Single-photo listings (tile image_count is authoritative): the tile
      // card above is already complete — gallery included — so skip the fetch
      // entirely. No second render, no reflow, no extra request. Docs indexed
      // before image_count existed report null and still fetch (safe fallback).
      if (tileGalleryComplete(typeof props.image_count === 'number' ? props.image_count : null)) {
        markerCacheRef.current.set(clickKey, {
          id: props.id,
          type: props.type,
          lat: pointLngLat.lat,
          lon: pointLngLat.lng,
          title: props.title || '',
          price: isProject ? (props.low_price ?? props.price ?? 0) : (props.price || 0),
          image: props.image_url || null,
          location: props.location_text || null,
          all_images: props.image_url ? [props.image_url] : [],
          bhk_type: props.bhk_type || null,
          bathrooms: props.bathrooms ?? null,
          balconies: props.balconies ?? null,
          furnishing_status: props.furnishing_status || null,
          listing_purpose: props.listing_purpose || null,
          area_sqft: props.area_sqft ?? null,
          area_unit: props.area_unit || null,
          location_text: props.location_text || null,
          low_price: props.low_price ?? null,
          high_price: props.high_price ?? null,
          developer_name: props.developer_name || null,
          construction_phase: props.construction_phase || null,
          construction_progress_percent: props.construction_progress_percent ?? null,
          delivery_date: props.delivery_date || null,
          property_type: props.property_type || null,
          amenities: tileAmenities,
          amenities_total: tileAmenitiesTotal,
          bedrooms_list: tileBeds,
          unit_count: props.unit_count ?? null,
          payment_plan_summary: props.payment_plan_summary || null,
        });
        return;
      }

      // Gallery top-up for multi-photo listings: the card above already shows
      // final text content, so this only grows the photo carousel (overlay
      // dots, zero reflow). Skipped entirely for single-photo/known tiles.
      // The card only upgrades if it is still open for THIS pin (X, background
      // click, or a newer pin click invalidates the upgrade).
      fetch(`/api/listings/${encodeURIComponent(props.id)}`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (reqId !== clickReqIdRef.current) return;
          if (listingCardId() !== props.id) return;
          if (!data || data.lat == null || data.lon == null) return;
          markerCacheRef.current.set(clickKey, {
            id: props.id,
            type: props.type,
            lat: data.lat,
            lon: data.lon,
            title: data.title,
            price: data.price,
            image: data.image_url,
            location: data.location_text,
            all_images: data.all_images || (data.image_url ? [data.image_url] : []),
            bhk_type: data.bhk_type || null,
            bathrooms: data.bathrooms ?? null,
            balconies: data.balconies ?? null,
            furnishing_status: data.furnishing_status || null,
            listing_purpose: data.listing_purpose || null,
            area_sqft: data.area_sqft ?? null,
            area_unit: data.area_unit || null,
            location_text: data.location_text || null,
            low_price: data.low_price ?? null,
            high_price: data.high_price ?? null,
            developer_name: data.developer_name || null,
            construction_phase: data.construction_phase || null,
            delivery_date: data.delivery_date || null,
            property_type: data.property_type || null,
            amenities: Array.isArray(data.amenities) ? data.amenities.slice(0, 6) : [],
            amenities_total: data.amenities_total ?? (Array.isArray(data.amenities) ? data.amenities.length : 0),
            bedrooms_list: Array.isArray(data.bedrooms_list) ? data.bedrooms_list : [],
            unit_count: data.unit_count ?? null,
            payment_plan_summary: data.payment_plan_summary || null,
            construction_progress_percent: data.construction_progress_percent ?? null,
          });
          showListingPreviewCard(map, data, pointLngLat);
        })
        .catch(() => { /* silent — instant tile card stays */ });
    };

    const onMapClick = () => {
      // Pin clicks dispatch here too — stand down while suppressed so the
      // just-opened card isn't closed in the same tick.
      if (Date.now() < suppressMapClickUntil.current) return;
      clickReqIdRef.current++;
      hideListingPreviewCard();
    };

    const onEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clickReqIdRef.current++;
        hideListingPreviewCard();
      }
    };

    // Fix Maptiler empty sprite URL issue — prevents "Image '' could not be loaded" errors
    map.on('style.load', () => {
      map.setSprite(null);
    });

    const onLoad = () => {
      map.addSource('boundary', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': 0 } });
      map.addLayer({ id: 'boundary-outline', type: 'line', source: 'boundary', paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [4, 4], 'line-opacity': 0 } });
      map.addLayer({ id: 'boundary-vertices', type: 'circle', source: 'boundary', filter: ['==', '$type', 'LineString'], paint: { 'circle-radius': 4, 'circle-color': '#2563eb', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      boundarySourceRef.current = map.getSource('boundary') as maplibregl.GeoJSONSource;

      // RECOVERY: If user selected a geocoded location before map finished loading,
      // the boundary polygon data was lost. Re-apply it now that the source exists.
      // Exact geocoded rings win; freehand falls back to its flat ring.
      if (geocodedRingsRef.current && geocodedRingsRef.current.length > 0) {
        updateBoundaryLayerRef.current(geocodedRingsRef.current, true);
        // Also fit viewport to the geocoded boundary (was skipped because mapRef was null)
        if (geocodedBoundsRef.current) {
          const b = geocodedBoundsRef.current;
          setTimeout(() => {
            map.fitBounds([b.minLng, b.minLat, b.maxLng, b.maxLat], { padding: 40, duration: 0 });
          }, 200);
        }
      } else if (drawPointsRef.current.length >= 3) {
        updateBoundaryLayerRef.current(drawPointsRef.current, true);
        if (geocodedBoundsRef.current) {
          const b = geocodedBoundsRef.current;
          setTimeout(() => {
            map.fitBounds([b.minLng, b.minLat, b.maxLng, b.maxLat], { padding: 40, duration: 0 });
          }, 200);
        }
      }

      setupMapLayers(map);

      // Admin-1 layers go under the markers (beforeId) and above nothing else;
      // safe no-op until the GeoJSON fetch resolves (ensureAdminLayersRef fires
      // again from the geo effect).
      ensureAdminLayers();
      applyTierForZoom();

      map.on('mousemove', 'unclustered-properties', onPointMouseMove);
      map.on('mousemove', 'unclustered-projects', onPointMouseMove);
      map.on('mouseleave', 'unclustered-properties', onPointMouseLeave);
      map.on('mouseleave', 'unclustered-projects', onPointMouseLeave);
      map.on('click', 'unclustered-properties', onPointClick);
      map.on('click', 'unclustered-projects', onPointClick);
      // Clicking the highlighted price-marker also opens the card
      map.on('click', 'highlighted-pin', onPointClick);
      // State hover/click are layer handlers, so MarkerLibre only dispatches
      // them when the point is actually inside a state polygon. Touch devices
      // get selection through the same click path (tap), with no hover
      // dependency; hover is a pointer-only enhancement.
      map.on('mousemove', ADMIN_LAYERS.fill, onStateMouseMove);
      map.on('mouseleave', ADMIN_LAYERS.fill, onStateMouseLeave);
      map.on('click', ADMIN_LAYERS.fill, onStateClick);
      map.on('zoomend', onZoomEnd);
      map.on('click', onMapClick);

      // Initial data load. If a location search is in progress, it already
      // fired a fetch with the correct geocoded bounds (and would abort this
      // one anyway via cancel-on-new); fetching here with the pre-fitBounds
      // viewport would only repaint stale, project-less markers.
      if (!geocodedBoundsRef.current) {
        fetchPropertiesRef.current(map.getBounds());
      }
      // Static init (center/zoom set in constructor) does NOT fire moveend,
      // so the initialMoveEndRef guard would otherwise swallow the USER's
      // first pan/zoom. Reset it here, after the initial load fetch.
      initialMoveEndRef.current = false;
    };

    let drawingStrokePoints: { lat: number; lng: number }[] = [];
    const onMouseDown = (e: maplibregl.MapMouseEvent) => {
      if (!isDrawingModeRef.current) return;
      e.originalEvent.preventDefault();
      e.originalEvent.stopPropagation();
      isDrawingRef.current = true;
      drawingStrokePoints = [{ lat: e.lngLat.lat, lng: e.lngLat.lng }];
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!isDrawingRef.current) return;
      const last = drawingStrokePoints[drawingStrokePoints.length - 1];
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (!last || Math.abs(pt.lat - last.lat) > 0.0002 || Math.abs(pt.lng - last.lng) > 0.0002) {
        drawingStrokePoints.push(pt);
        updateBoundaryLayerRef.current([...drawPointsRef.current, ...drawingStrokePoints]);
      }
    };
    const onMouseUp = () => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      if (drawingStrokePoints.length > 1) {
        drawPointsRef.current = [...drawPointsRef.current, ...drawingStrokePoints];
      }
      drawingStrokePoints = [];
      setBoundaryPoints([...drawPointsRef.current]);
    };

    const onMoveEnd = () => {
      if (initialMoveEndRef.current) {
        initialMoveEndRef.current = false;
        return;
      }

      // The fixed click card stays open across pans (Zillow-style) — it is
      // re-anchored on every 'move' below. It closes only via X, background
      // click, another pin click, or Escape. In-flight click fetches stay valid
      // because the card's geographic anchor never changes.
      repositionListingCard(map);

      // If we just completed a geocoded location fitBounds, skip the redundant fetch.
      // The initial fetchAllProperties from selectSuggestion already handles the data.
      if (geocodedBoundsRef.current) {
        geocodedBoundsRef.current = null;
        return;
      }

      if (searchAsIMoveRef.current) {
        // 400ms debounce for pan-triggered searches (spec §8: 300-500ms + cancel).
        // Pans re-query the full endpoint with exact viewport bounds — the
        // response paints dots AND refreshes list/totals together, so the
        // sidebar can never desync from the map.
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          fetchPropertiesRef.current(map.getBounds());
        }, 400);
      }
    };

    // Keep the open click card glued to its geographic anchor while panning.
    const onMove = () => {
      repositionListingCard(map);
    };

    map.on('load', onLoad);
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    map.on('moveend', onMoveEnd);
    map.on('move', onMove);
    document.addEventListener('keydown', onEscapeKey);

    return () => {
      map.off('load', onLoad);
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.off('moveend', onMoveEnd);
      map.off('move', onMove);
      document.removeEventListener('keydown', onEscapeKey);
      map.off('mousemove', 'unclustered-properties', onPointMouseMove);
      map.off('mousemove', 'unclustered-projects', onPointMouseMove);
      map.off('mouseleave', 'unclustered-properties', onPointMouseLeave);
      map.off('mouseleave', 'unclustered-projects', onPointMouseLeave);
      map.off('click', 'unclustered-properties', onPointClick);
      map.off('click', 'unclustered-projects', onPointClick);
      map.off('click', 'highlighted-pin', onPointClick);
      map.off('click', onMapClick);
      // Admin-1 teardown: unregister once-only listeners, clear hover state
      // and remove the tooltip element; layers go with the map itself.
      map.off('mousemove', ADMIN_LAYERS.fill, onStateMouseMove);
      map.off('mouseleave', ADMIN_LAYERS.fill, onStateMouseLeave);
      map.off('click', ADMIN_LAYERS.fill, onStateClick);
      map.off('zoomend', onZoomEnd);
      hideStateTooltip();
      destroyStateTooltip();
      removeAdminLayers(map);
      if (stateCountTimerRef.current) clearTimeout(stateCountTimerRef.current);
      if (zoomTierTimerRef.current) clearTimeout(zoomTierTimerRef.current);
      if (statePrefetchTimerRef.current) clearTimeout(statePrefetchTimerRef.current);
      if (stateCountAbortRef.current) stateCountAbortRef.current.abort();
      removeMapLayers(map);
      destroyPreviewCards();
      map.remove();
      mapRef.current = null;
    };
    }, [router, fetchStateDetail]);

  useEffect(() => {
    const resizer = resizerRef.current;
    if (!resizer) return;
    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      setSidebarOpen(true);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.max(320, Math.min(800, e.clientX));
      setPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    resizer.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      resizer.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // MapLibre needs an explicit resize after the sidebar width changes so the
  // map fills the newly available space without stale projection dimensions.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const frame = requestAnimationFrame(() => map.resize());
    const timer = window.setTimeout(() => map.resize(), 320);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [sidebarOpen, panelWidth, fullScreenResults]);

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    // A6: functional update — never rebuild from possibly-stale filtersRef
    const name = e.target.name;
    const val = e.target.value;
    setFilters(prev => ({ ...prev, [name]: val }));
    filtersRef.current = { ...filtersRef.current, [name]: val };
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
  };

  const handleQuickFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const name = e.target.name;
    const val = e.target.value;
    setFilters(prev => ({ ...prev, [name]: val }));
    filtersRef.current = { ...filtersRef.current, [name]: val };
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fetchPropertiesRef.current(
        searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
      );
    }, 500);  // 500ms debounce for filter changes
  };

  // Zillow-style price slider: live drag updates state only; commit (drag-end
  // / input blur) debounces the ES fetch like other quick filters.
  const priceRangeValue: PriceRangeValue = {
    min: filters.minPrice ? Number(filters.minPrice) || undefined : undefined,
    max: filters.maxPrice ? Number(filters.maxPrice) || undefined : undefined,
  };
  const priceCurrency = searchScope === 'projects' ? tenant.projectCurrency : tenant.propertyCurrency;
  // Rent uses monthly bands; Buy/All use sale bands (All shows mixed caption).
  const pricePurpose = intent === 'rent' ? 'rent' : 'sale';
  const handlePriceChange = (v: PriceRangeValue) => {
    const next = {
      minPrice: v.min != null ? String(v.min) : '',
      maxPrice: v.max != null ? String(v.max) : '',
    };
    setFilters(prev => ({ ...prev, ...next }));
    filtersRef.current = { ...filtersRef.current, ...next };
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
  };
  const handlePriceCommit = (v: PriceRangeValue) => {
    handlePriceChange(v);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fetchPropertiesRef.current(
        searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
      );
    }, 500);
  };

  const handleApplyFiltersWithLocation = async (
    locationText: string,
    explicit?: { rings: BoundaryRings | null; bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null } | null
  ) => {
    // Explicit geometry (from suggestion select by feature id) always wins —
    // no text re-geocode, so the filter can never belong to another entity.
    if (explicit !== undefined && explicit !== null) {
      if (explicit.rings && explicit.rings.length > 0 && explicit.bbox) {
        applyGeocodedBoundary(explicit.rings, explicit.bbox, locationText);
      }
      // rings null (center-only) / bbox already set by the caller: fall through
      // straight to the fetch with the caller's state.
    } else if (locationText && process.env.NEXT_PUBLIC_MAPTILER_KEY && !geocodedBoundsRef.current) {
      // Typed-text fallback only (no suggestion geometry): resolve geography by
      // text, keeping ALL outer rings so mainland + islands filter together.
      setSearchAsIMove(true);
      try {
        // Step 1: Forward geocoding — get feature IDs + bbox
        const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(locationText)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}${process.env.NEXT_PUBLIC_GEOCODE_COUNTRIES ? `&country=${process.env.NEXT_PUBLIC_GEOCODE_COUNTRIES}` : ''}&language=en`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`geocode ${response.status}`);
        const data = await response.json();
        if (data.features && data.features.length > 0) {
          const feature = data.features[0];

          // Step 2: Fetch actual polygon geometry by feature ID
          let rings: BoundaryRings = [];
          if (feature.id) {
            try {
              const geomResponse = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(feature.id)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}&language=en`, { signal: AbortSignal.timeout(3000) });
              if (!geomResponse.ok) throw new Error(`geometry ${geomResponse.status}`);
              const geomData = await geomResponse.json();
              rings = allRingsFromGeometry(geomData.features?.[0]?.geometry);
            } catch {}
          }

          if (rings.length > 0) {
            // Prefer the authoritative feature bbox for the viewport (covers
            // the full extent even when rings are fragmented) — unless it is
            // a degenerate point, in which case derive from the rings.
            const bbox = (feature.bbox && feature.bbox.length === 4 && !isDegenerateBbox(feature.bbox))
              ? { minLng: feature.bbox[0], minLat: feature.bbox[1], maxLng: feature.bbox[2], maxLat: feature.bbox[3] }
              : {
                  minLat: Math.min(...rings.flat().map(p => p.lat)),
                  maxLat: Math.max(...rings.flat().map(p => p.lat)),
                  minLng: Math.min(...rings.flat().map(p => p.lng)),
                  maxLng: Math.max(...rings.flat().map(p => p.lng)),
                };
            applyGeocodedBoundary(rings, bbox, locationText);
          } else {
            // No polygon on the MapTiler entity (city/neighborhood centroids).
            // Try OSM for the real locality polygon; a bounding box is never
            // drawn. Fall back to a center lookup only when nothing validates.
            const center: [number, number] | null = Array.isArray(feature.center) && feature.center.length === 2
              ? [Number(feature.center[0]), Number(feature.center[1])]
              : feature.bbox && feature.bbox.length === 4
                ? [(Number(feature.bbox[0]) + Number(feature.bbox[2])) / 2, (Number(feature.bbox[1]) + Number(feature.bbox[3])) / 2]
                : null;
            const place = center ? await resolvePlaceGeometryOSM(locationText, center) : null;
            if (place) {
              applyGeocodedBoundary(place.rings, place.bbox, locationText);
            } else if (center && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
              // Center lookup: bounds box around the point, no outline.
              clearBoundaryState();
              mapRef.current?.flyTo({ center, zoom: 13, essential: true });
              geocodedBoundsRef.current = { minLat: center[1] - 0.1, maxLat: center[1] + 0.1, minLng: center[0] - 0.1, maxLng: center[0] + 0.1 };
            }
          }
        }
      } catch {}
    }
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setCombinedNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
    // Use geocoded bounds if available (target area), otherwise fall back to current map viewport
    const searchBounds = geocodedBoundsRef.current
      ? { getSouthWest: () => ({ lat: geocodedBoundsRef.current!.minLat, lng: geocodedBoundsRef.current!.minLng }),
          getNorthEast: () => ({ lat: geocodedBoundsRef.current!.maxLat, lng: geocodedBoundsRef.current!.maxLng }) }
      : (searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null);
    // Pass exact boundary rings directly (avoids stale-closure issues).
    // Geocoded rings win; freehand falls back to its flat ring.
    const activeRings: BoundaryRings | null =
      geocodedRingsRef.current && geocodedRingsRef.current.length > 0
        ? geocodedRingsRef.current
        : drawPointsRef.current.length >= 3
          ? [drawPointsRef.current]
          : null;
    fetchAllProperties(searchBounds as any, undefined, activeRings as any);
  };

  const handleApplyFilters = async () => {
    handleApplyFiltersWithLocation(filtersRef.current.location);
  };

  const handleResetFilters = () => {
    const defaultFilters = { location: '', minPrice: '', maxPrice: '', bhkTypeId: '', propertyTypeId: '' };
    filtersRef.current = defaultFilters;
    geocodedBoundsRef.current = null; // Clear any geocoded location
    geocodedRingsRef.current = null; // Clear exact-ring boundary with it
    cancelAutocomplete();  // A5: reset autocomplete state on reset
    setLoading(true);
    setFilters(defaultFilters);
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setCombinedNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
    setSortedResultOrder([]);
    setProperties([]);
    setProjects([]);
    setPropertyTotal(0);
    setProjectTotal(0);
    setBoundaryActive(false);
    setBoundaryPoints([]);
    setIsDrawingMode(false);
    drawPointsRef.current = [];
    updateBoundaryLayerRef.current([]);
    resetStateSelection();
    if (mapRef.current) {
      mapRef.current.dragPan.enable();
      mapRef.current.scrollZoom.enable();
      mapRef.current.boxZoom.enable();
      mapRef.current.doubleClickZoom.enable();
      mapRef.current.getCanvas().style.cursor = '';
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    fetchPropertiesRef.current(
      searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null,
      undefined,
      undefined,
      null
    );
  };

  const loadMore = useCallback(() => {
    const bounds = searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null;
    const scope = searchScopeRef.current;
    // Explicit rings (not closure state): paginated pages filter the exact
    // same boundary as page one. Geocoded exact rings win over freehand.
    const activeRings: BoundaryRings | null =
      geocodedRingsRef.current && geocodedRingsRef.current.length > 0
        ? geocodedRingsRef.current
        : boundaryActiveRef.current && drawPointsRef.current.length >= 3
          ? [drawPointsRef.current]
          : null;
    if (scope === 'both') {
      if (combinedNextCursor) {
        fetchAllProperties(bounds, {
          propertyCursor: combinedNextCursor,
          append: true,
        }, activeRings);
      }
    } else {
      fetchAllProperties(bounds, {
        propertyCursor: (scope !== 'projects' && hasMoreProperties) ? propertyNextCursor : null,
        projectCursor: (scope !== 'properties' && hasMoreProjects) ? projectNextCursor : null,
        append: true,
      }, activeRings);
    }
  }, [propertyNextCursor, projectNextCursor, hasMoreProperties, hasMoreProjects, combinedNextCursor]);

  const useUserLocation = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by your browser');
      return;
    }
    setIsLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        mapRef.current?.flyTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 14, essential: true });
        setIsLocating(false);
      },
      (err) => {
        setLocationError(err.code === 1 ? 'Location access denied. Please enable permissions.' : 'Unable to get location. Try again.');
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  const handleScopeChange = (scope: SearchScope) => {
    // Rent intent is properties-only (projects are sale inventory).
    const effectiveScope = intentRef.current === 'rent' && scope !== 'properties' ? 'properties' : scope;
    setSearchScope(effectiveScope);
    // The fetch below runs synchronously, before React re-renders — without
    // updating the ref here the request would use the PREVIOUS scope, leaving
    // markers/counts one mode behind the toggle (and, on the next refetch,
    // querying the wrong mode entirely).
    searchScopeRef.current = effectiveScope;
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
    setCombinedNextCursor(null);
    setSortedResultOrder([]);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    fetchPropertiesRef.current(
      searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
    );
  };

  const handleIntentChange = (next: Intent) => {
    setIntent(next);
    intentRef.current = next;
    // Sale↔rent price bands differ ~400×: never carry values across intents.
    setFilters(prev => ({ ...prev, minPrice: '', maxPrice: '' }));
    filtersRef.current = { ...filtersRef.current, minPrice: '', maxPrice: '' };
    // Rent forces properties scope; Buy leaves scope as-is.
    if (next === 'rent' && searchScopeRef.current !== 'properties') {
      setSearchScope('properties');
      searchScopeRef.current = 'properties'; // fetch below must not read the old scope
    }
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
    setCombinedNextCursor(null);
    setSortedResultOrder([]);
    try {
      router.replace(`/browse${withIntentInSearch(window.location.search, next)}`, { scroll: false });
    } catch {}
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      fetchPropertiesRef.current(
        searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
      );
    }, 200);
  };

  // Deep-link ?intent= (default buy). Browse tabs are Buy|Rent only, so
  // Lease/PG deep-links (e.g. shared from /list) map to the Rent tab.
  useEffect(() => {
    try {
      const parsed = parseIntentFromSearch(window.location.search);
      const initial = parsed === 'lease' || parsed === 'pg' ? 'rent' : parsed;
      setIntent(initial);
      intentRef.current = initial;
      if (initial === 'rent') setSearchScope('properties');
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateBoundaryLayer = useCallback((points: { lat: number; lng: number }[] | BoundaryRings, isActive?: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('boundary') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    // Accept a single flat ring (freehand) or all outer rings of a geocoded
    // entity (exact outline incl. islands). MultiPolygon $type still matches
    // the Polygon fill/outline layers.
    const rings: BoundaryRings =
      points.length > 0 && Array.isArray((points as any)[0])
        ? (points as BoundaryRings).filter(r => Array.isArray(r) && r.length >= 3)
        : (points as { lat: number; lng: number }[]).length >= 3
          ? [[...(points as { lat: number; lng: number }[])]]
          : [];
    const closeRing = (ring: BoundaryRing[]): [number, number][] => {
      const coords: [number, number][] = ring.map(p => [p.lng, p.lat]);
      coords.push(coords[0]);
      return coords;
    };
    if (rings.length === 0) {
      // Fewer than 3 points: clear, or preview a freehand stroke as a line.
      const flat = points as { lat: number; lng: number }[];
      if (!Array.isArray((points as any)[0]) && flat.length >= 2) {
        const coords: [number, number][] = flat.map(p => [p.lng, p.lat]);
        src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString' as const, coordinates: coords }, properties: {} }] } as any);
        map.setPaintProperty('boundary-outline', 'line-opacity', 0.8);
      } else {
        src.setData({ type: 'FeatureCollection', features: [] } as any);
        map.setPaintProperty('boundary-fill', 'fill-opacity', 0);
        map.setPaintProperty('boundary-outline', 'line-opacity', 0);
        map.setPaintProperty('boundary-vertices', 'circle-opacity', 0);
      }
      return;
    }
    const geometry = rings.length === 1
      // Close the polygon ring (GeoJSON RFC 7946 requires first == last)
      ? { type: 'Polygon' as const, coordinates: [closeRing(rings[0])] }
      : { type: 'MultiPolygon' as const, coordinates: rings.map(r => [closeRing(r)]) };
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] } as any);
    const active = isActive ?? false;
    // Outline only: never fill or tint the map — the base map stays normal.
    map.setPaintProperty('boundary-fill', 'fill-opacity', 0);
    map.setPaintProperty('boundary-outline', 'line-opacity', 0.9);
    map.setPaintProperty('boundary-outline', 'line-width', 1.5);
    map.setPaintProperty('boundary-outline', 'line-dasharray', active ? [1, 0] : [4, 4]);
    map.setPaintProperty('boundary-vertices', 'circle-opacity', 0);
  }, []);

  useEffect(() => {
    updateBoundaryLayerRef.current = updateBoundaryLayer;
  }, [updateBoundaryLayer]);

  type GeoBounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

  // Single choke point for geocoded boundaries: the outline drawn and the
  // rings sent to ES come from the SAME array, so they can never disagree.
  // Drop the state selection without refetching; used when another boundary
  // type replaces it (geocoded rings, freehand draw, reset). The full-detail
  // outline is dropped with it and the overview line is restored for all states.
  const resetStateSelection = useCallback(() => {
    const prev = selectedStateRef.current;
    if (prev && mapRef.current) {
      setAdminSelected(mapRef.current, null, prev.id);
      setOverviewSelectedExcluded(mapRef.current, null);
      setSelectedDetail(mapRef.current, null);
    }
    selectedStateRef.current = null;
    setSelectedState(null);
  }, []);

  const applyGeocodedBoundary = useCallback((rings: BoundaryRings, bbox: GeoBounds | null, label?: string | null) => {
    // A geocoded boundary replaces any state selection (single filter source).
    resetStateSelection();
    const valid = (rings || []).filter(r => Array.isArray(r) && r.length >= 3);
    geocodedRingsRef.current = valid.length > 0 ? valid : null;
    drawPointsRef.current = [];
    setActiveBoundaryLabel(valid.length > 0 ? (label?.trim() || 'Selected area') : null);
    if (valid.length > 0) {
      setBoundaryPoints(valid.flat());
      setBoundaryActive(true);
      updateBoundaryLayerRef.current(valid, true);
      if (bbox) {
        geocodedBoundsRef.current = bbox;
        if (mapRef.current) {
          mapRef.current.fitBounds(
            [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat],
            { padding: 40, duration: 800 }
          );
        }
      }
    }
  }, [resetStateSelection]);

  // Full boundary reset: outline, filter rings, freehand accumulator, bounds.
  const clearBoundaryState = useCallback(() => {
    geocodedRingsRef.current = null;
    drawPointsRef.current = [];
    setBoundaryPoints([]);
    setBoundaryActive(false);
    setActiveBoundaryLabel(null);
    geocodedBoundsRef.current = null;
    updateBoundaryLayerRef.current([]);
  }, []);

  const activateDrawing = useCallback(() => {
    // Drawing replaces any state selection.
    resetStateSelection();
    setIsDrawingMode(true);
    setBoundaryPoints([]);
    drawPointsRef.current = [];
    // Freehand replaces any geocoded boundary — clear exact rings so they
    // can't keep filtering alongside the new drawing.
    geocodedRingsRef.current = null;
    if (mapRef.current) {
      const source = mapRef.current.getSource('browse-points') as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData({ type: 'FeatureCollection', features: [] });
      }
      mapRef.current.dragPan.disable();
      mapRef.current.scrollZoom.disable();
      mapRef.current.boxZoom.disable();
      mapRef.current.doubleClickZoom.disable();
      mapRef.current.getCanvas().style.cursor = 'crosshair';
    }
  }, [resetStateSelection]);

  const cancelDrawing = useCallback(() => {
    setIsDrawingMode(false);
    // Full reset: a cancelled draw leaves no stale geocoded rings behind.
    geocodedRingsRef.current = null;
    geocodedBoundsRef.current = null;
    drawPointsRef.current = [];
    setBoundaryPoints([]);
    setBoundaryActive(false);
    setActiveBoundaryLabel(null);
    updateBoundaryLayer([]);
    if (mapRef.current) {
      mapRef.current.dragPan.enable();
      mapRef.current.scrollZoom.enable();
      mapRef.current.boxZoom.enable();
      mapRef.current.doubleClickZoom.enable();
      mapRef.current.getCanvas().style.cursor = '';
    }
    fetchPropertiesRef.current(mapRef.current ? mapRef.current.getBounds() : null);
  }, [updateBoundaryLayer]);

  const applyBoundary = useCallback(() => {
    // A freehand boundary replaces any state selection (single filter source).
    resetStateSelection();
    const pts = drawPointsRef.current;
    if (pts.length < 3) return;
    const simplified = simplifyPolygon(pts);
    drawPointsRef.current = simplified;
    setBoundaryPoints(simplified);
    setBoundaryActive(true);
    setActiveBoundaryLabel('Drawn boundary');
    setIsDrawingMode(false);
    if (mapRef.current) {
      mapRef.current.dragPan.enable();
      mapRef.current.scrollZoom.enable();
      mapRef.current.boxZoom.enable();
      mapRef.current.doubleClickZoom.enable();
      mapRef.current.getCanvas().style.cursor = '';
    }
    updateBoundaryLayer(simplified, true);
    // Pass current map bounds instead of null — null causes 400 "bounds required" error
    const bounds = mapRef.current?.getBounds() ?? null;
    fetchPropertiesRef.current(bounds, undefined, [simplified]);
  }, [updateBoundaryLayer, resetStateSelection]);

  const removeBoundary = useCallback(() => {
    setBoundaryActive(false);
    setBoundaryPoints([]);
    setActiveBoundaryLabel(null);
    setIsDrawingMode(false);
    drawPointsRef.current = [];
    geocodedRingsRef.current = null;
    geocodedBoundsRef.current = null;
    updateBoundaryLayer([]);
    if (mapRef.current) {
      mapRef.current.dragPan.enable();
      mapRef.current.scrollZoom.enable();
      mapRef.current.boxZoom.enable();
      mapRef.current.doubleClickZoom.enable();
      mapRef.current.getCanvas().style.cursor = '';
    }
    fetchPropertiesRef.current(mapRef.current ? mapRef.current.getBounds() : null);
  }, [updateBoundaryLayer]);

  // ---- Interactive state/emirate selection -------------------------------
  // The state id is the only filter token sent to the server — the rings stay
  // server-side so outline, count, and ES filter can never drift (AD3/AD5).
  const selectState = useCallback((id: string, name: string, bbox: [number, number, number, number]) => {
    const map = mapRef.current;
    // A state selection is a boundary selection: replace any geocoded/freehand
    // boundary so exactly one filter geometry is ever active.
    clearBoundaryState();
    const prev = selectedStateRef.current;
    if (map) {
      // Selection must be independent of hover: drop the hover feature-state so
      // the blue hover fill cannot linger as if it were the selected styling
      // (selected regions render as an outline only).
      clearAdminHover(map, stateHoverRef.current);
      setAdminDetailState(map, null, stateHoverRef.current);
      stateHoverRef.current = null;
      stateHoverDetailRef.current = null;
      setHoverDetail(map, null);
      setOverviewHoverExcluded(map, null);
      setAdminSelected(map, id, prev && prev.id !== id ? prev.id : null);
      // The simplified overview line is replaced by the canonical outline as
      // soon as it is available (cached after a hover or prefetch), so the two
      // never draw on top of each other.
      setOverviewSelectedExcluded(map, id);
      const beforeId = map.getLayer('unclustered-properties')
        ? 'unclustered-properties'
        : map.getLayer('unclustered-properties-halo')
          ? 'unclustered-properties-halo'
          : undefined;
      const sha = (adminGeoRef.current?.features || []).find((f: any) => String(f.id) === id)?.properties?.sha;
      fetchStateDetail(id, typeof sha === 'string' ? sha : null)
        .then((fc) => {
          // Ignore stale responses (a newer state may have been selected, or
          // the map may have been torn down) — same epoch discipline as search.
          if (!fc || selectedStateRef.current?.id !== id || mapRef.current !== map) return;
          setSelectedDetail(map, fc.features[0], beforeId);
        })
        .catch(() => { /* the overview outline remains until a retry succeeds */ });
    }
    const next = { id, name };
    selectedStateRef.current = next;
    setSelectedState(next);
    applyAdminTierRef.current?.();
    if (map) {
      // Same latch geocoded selections use: the post-fitBounds moveend becomes
      // a no-op instead of a duplicate corrective fetch.
      geocodedBoundsRef.current = { minLat: bbox[1], maxLat: bbox[3], minLng: bbox[0], maxLng: bbox[2] };
      map.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], { padding: 40, duration: 800 });
    }
    const boundsDuck = {
      getSouthWest: () => ({ lat: bbox[1], lng: bbox[0] }),
      getNorthEast: () => ({ lat: bbox[3], lng: bbox[2] }),
    } as unknown as LngLatBounds;
    fetchPropertiesRef.current(boundsDuck, undefined, undefined, id);
  }, [clearBoundaryState]);

  const clearStateSelection = useCallback(() => {
    resetStateSelection();
    fetchPropertiesRef.current(mapRef.current ? mapRef.current.getBounds() : null, undefined, undefined, null);
  }, [resetStateSelection]);

  // The single overlay control's remove action: a state selection drops the
  // state filter; any other boundary (geocoded locality or freehand) goes
  // through the full boundary reset, which also refetches the listings.
  const removeActiveBoundary = useCallback(() => {
    if (selectedStateRef.current) {
      clearStateSelection();
      return;
    }
    removeBoundary();
  }, [clearStateSelection, removeBoundary]);

  // Publish to the map-lifecycle effect (which runs before this definition).
  selectStateRef.current = selectState;

  const SCOPE_OPTIONS: { value: SearchScope; label: string; icon: React.ReactNode }[] = [
    { value: 'properties', label: 'Properties', icon: <FaHome size={12} /> },
    { value: 'projects', label: 'Projects', icon: <FaBuilding size={12} /> },
    { value: 'both', label: 'Both', icon: null },
  ];

  const viewListIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );

  const viewGridIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );

  const viewCompactIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="5" height="5" rx="1" /><rect x="10" y="3" width="5" height="5" rx="1" /><rect x="17" y="3" width="5" height="5" rx="1" /><rect x="3" y="10" width="5" height="5" rx="1" /><rect x="10" y="10" width="5" height="5" rx="1" /><rect x="17" y="10" width="5" height="5" rx="1" />
    </svg>
  );

  const activeFilterCount = Object.values(filters).filter(value => value.trim().length > 0).length
    + (boundaryActive ? 1 : 0)
    + (selectedState ? 1 : 0);

  // Single boundary-control descriptor for the map overlay: the selected
  // region's name, the geocoded locality name / freehand marker, or null →
  // the control shows the "Draw Boundary" action instead.
  const boundaryLabel = selectedState?.name ?? (boundaryActive ? (activeBoundaryLabel ?? 'Custom boundary') : null);

  const sidebarToggleIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );

  const chevronDown = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );

  return (
    <div className="flex flex-col h-screen bg-bg-color">
      <Header />
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT PANEL: Collapsible Filters + Results */}
        <aside className={cn(
          "bg-bg-color border-r border-shadow-dark/20 flex flex-col min-w-0 overflow-hidden transition-all duration-300 ease-in-out",
          "md:flex",
          mobileView === 'list' ? "flex" : "hidden"
        )}
          style={{
            width: fullScreenResults ? '100%' : sidebarOpen ? `${panelWidth}px` : '0px',
            maxWidth: fullScreenResults ? '100%' : sidebarOpen ? `${panelWidth}px` : '0px',
            flex: fullScreenResults ? '1 1 auto' : sidebarOpen ? '0 0 auto' : '0 0 0px',
          }}
        >

          {/* ONE SCROLL SURFACE: toggle row, filters, and results scroll
              together. Nothing is pinned here, so filter sections scroll out
              of view naturally; the manual ^ toggle stays the explicit
              collapse control. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
           {/* SIDEBAR TOGGLE + FILTER ACCORDION */}
            <div className="p-4 pb-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Hide filters sidebar"
                  title="Hide filters sidebar"
                  className="flex h-11 items-center justify-center rounded-2xl px-3 text-text-color-dark shadow-neumorphic-outset hover:bg-shadow-dark/5 transition-colors"
                >
                  {sidebarToggleIcon}
                </button>
                <button
                  type="button"
                  onClick={() => setFilterOpen(!filterOpen)}
                  aria-expanded={filterOpen}
                  className="flex-1 flex items-center justify-between px-4 py-3 rounded-2xl shadow-neumorphic-outset text-sm font-semibold text-text-color-dark hover:bg-shadow-dark/5 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    Filters
                    {activeFilterCount > 0 && (
                      <span className="inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">
                        {activeFilterCount}
                      </span>
                    )}
                  </span>
                  <span className={`transition-transform duration-300 ${filterOpen ? 'rotate-180' : ''}`}>
                    {chevronDown}
                  </span>
                </button>
              </div>
            </div>

           {/* FILTER CONTENT (accordion): grid-rows animation grows to the
               card's natural height — no fixed cap to clip on short viewports. */}
            <div className={cn(
              "grid transition-all duration-300 ease-in-out",
              filterOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
            )}>
             <div className="overflow-hidden">
             <div className="px-4 pb-2">
              <div className="shadow-neumorphic-outset rounded-3xl p-4 space-y-4">

                {/* Intent Selector: Buy | Rent (Buy: Properties/Projects/Both; Rent: Properties only) */}
                <IntentTabs value={intent} onChange={handleIntentChange} />

                {/* Scope Selector */}
                <div className="flex gap-1 p-1 rounded-2xl shadow-neumorphic-inset">
                  {SCOPE_OPTIONS.map(opt => {
                    const disabledByIntent = intent === 'rent' && opt.value !== 'properties';
                    return (
                      <button
                        key={opt.value}
                        onClick={() => handleScopeChange(opt.value)}
                        disabled={disabledByIntent}
                        title={disabledByIntent ? 'Projects only listed for sale' : undefined}
                        className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2 px-3 rounded-xl transition-all ${
                          searchScope === opt.value
                            ? 'shadow-neumorphic-outset bg-bg-color text-text-color-dark'
                            : 'text-text-color-light hover:text-text-color-dark'
                        } ${disabledByIntent ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        {opt.icon && opt.icon}
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {intent === 'rent' && (
                  <p className="text-[11px] text-text-color-light text-center -mt-2">
                    Projects only listed for sale.
                  </p>
                )}

                {/* Location Search */}
                <div className="relative" ref={autocompleteRef}>
                  <input type="text" name="location" placeholder="Search by location..." value={filters.location} onChange={handleLocationChange} className="neumorphic-input w-full"/>
                  {showSuggestions && (
                    <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                      {suggestions.map((s, i) => (
                        <div key={i} onClick={() => selectSuggestion(s)} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-blue-50 cursor-pointer transition-colors">
                          <span className="text-base flex-shrink-0">
                            {s.type === 'location' ? '📍' : s.type === 'project' ? '🏗️' : '🏢'}
                          </span>
                          <span className="flex-1 truncate">{s.text}</span>
                          <span className="text-xs text-gray-400 flex-shrink-0 capitalize">{s.type}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Price Range */}
                <PriceRangeFilter
                  id="browse-price"
                  currency={priceCurrency}
                  purpose={pricePurpose}
                  value={priceRangeValue}
                  onChange={handlePriceChange}
                  onCommit={handlePriceCommit}
                />

                {/* BHK + Property Type */}
                <div className="grid grid-cols-2 gap-2">
                  <select name="bhkTypeId" value={filters.bhkTypeId} onChange={handleFilterChange} className="neumorphic-input w-full text-sm"><option value="">Any BHK</option>{bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
                  <select name="propertyTypeId" value={filters.propertyTypeId} onChange={handleFilterChange} className="neumorphic-input w-full text-sm"><option value="">Any Type</option>{propertyTypes.filter((p: any) => p.parent_id != null || !propertyTypes.some((c: any) => c.parent_id === p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                </div>

                {/* Search as I Move */}
                <div className="flex items-center justify-between p-2 rounded-2xl">
                  <label htmlFor="search-as-i-move" className="text-sm font-medium text-text-color-dark">Search as I move</label>
                  <input id="search-as-i-move" type="checkbox" checked={searchAsIMove} onChange={() => setSearchAsIMove(!searchAsIMove)} className="h-4 w-4 rounded shadow-neumorphic-inset appearance-none checked:bg-success-color transition"/>
                </div>

                {/* Apply + Reset */}
                <div className="flex gap-2">
                  <button onClick={handleApplyFilters} className="neumorphic-button bg-cta-gradient flex-1">Apply Filters</button>
                  <button onClick={handleResetFilters} className="neumorphic-button flex-1">Reset Filters</button>
                </div>

                {/* My Location */}
                <div>
                  <button onClick={useUserLocation} disabled={isLocating} className="neumorphic-button w-full flex items-center justify-center gap-2">
                    {isLocating ? <FaSpinner className="animate-spin"/> : <FaCrosshairs/>} {isLocating ? 'Locating...' : 'Use My Location'}
                  </button>
                  {locationError && <p className="text-xs text-danger-color mt-1 text-center">{locationError}</p>}
                </div>
              </div>
            </div>
            </div>
          </div>

          {/* RESULTS LIST (natural flow: the panel itself is the scroll surface) */}
          <div className="px-4 pb-4 space-y-3">
            {combinedList.length > 0 && (
              <>
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs font-semibold text-text-color-light">
                    {searchScope === 'properties' && `Properties (${propertyTotal})`}
                    {searchScope === 'projects' && `Projects (${projectTotal})`}
                    {searchScope === 'both' && `Properties (${propertyTotal}) · Projects (${projectTotal})`}
                  </span>
                  <div className="flex items-center gap-1">
                    {/* View mode toggles */}
                    <div className="flex gap-0.5 p-0.5 rounded-lg bg-shadow-dark/5">
                      {([{ key: 'list', icon: viewListIcon }, { key: 'grid', icon: viewGridIcon }, { key: 'compact', icon: viewCompactIcon }] as const).map(v => (
                        <button
                          key={v.key}
                          onClick={() => setViewMode(v.key)}
                          className={`p-1.5 rounded-md transition-all ${
                            viewMode === v.key
                              ? 'bg-bg-color shadow-sm text-text-color-dark'
                              : 'text-text-color-light hover:text-text-color-dark'
                          }`}
                          title={`${v.key} view`}
                        >
                          {v.icon}
                        </button>
                      ))}
                    </div>
                    {/* Map / List View toggle */}
                    <div className="flex gap-0.5 p-0.5 rounded-lg bg-shadow-dark/5">
                      <button
                        onClick={() => setFullScreenResults(false)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                          !fullScreenResults
                            ? 'bg-bg-color shadow-sm text-text-color-dark'
                            : 'text-text-color-light hover:text-text-color-dark'
                        }`}
                        title="Map View"
                      >
                        <FaMap size={11} />
                        Map
                      </button>
                      <button
                        onClick={() => setFullScreenResults(true)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
                          fullScreenResults
                            ? 'bg-bg-color shadow-sm text-text-color-dark'
                            : 'text-text-color-light hover:text-text-color-dark'
                        }`}
                        title="List View"
                      >
                        <FaList size={11} />
                        List
                      </button>
                    </div>
                  </div>
                </div>

                {/* Sort & Quick Filter Bar */}
                <div className="sticky top-0 z-10 bg-bg-color/90 backdrop-blur-sm pt-0.5 pb-1.5 -mx-4 px-4 border-b border-shadow-dark/5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={sortBy}
                      onChange={e => {
                        setSortBy(e.target.value as SortOption);
                        setPropertyNextCursor(null);
                        setProjectNextCursor(null);
                        setHasMoreProperties(false);
                        setHasMoreProjects(false);
                        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                        debounceTimerRef.current = setTimeout(() => {
                          fetchPropertiesRef.current(
                            searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
                          );
                        }, 500);
                      }}
                      className="neumorphic-input !w-auto !min-w-[130px] text-xs py-1.5"
                    >
                      <option value="newest">Newest</option>
                      <option value="popular">Most Popular</option>
                      <option value="price_asc">Price Low → High</option>
                      <option value="price_desc">Price High → Low</option>
                      <option value="beds">Bedrooms</option>
                      <option value="baths">Bathrooms</option>
                      <option value="sqft">Area (sqft)</option>
                      <option value="lot">Lot Size</option>
                    </select>

                    {/* BHK quick filter */}
                    <select
                      value={filters.bhkTypeId}
                      name="bhkTypeId"
                      onChange={handleQuickFilterChange}
                      className="neumorphic-input !w-auto !min-w-[70px] text-xs py-1.5"
                    >
                      <option value="">Any BHK</option>
                      {bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                    </select>
                  </div>
                </div>
              </>
            )}

            {loading ? (
              <div className="flex justify-center items-center h-40">
                <FaSpinner className="animate-spin text-3xl text-text-color-light" />
              </div>
            ) : (
              <>
                {searchScope === 'both' ? (
              <div className={cn(
                viewMode === 'list' ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : "",
                viewMode === 'grid' ? "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" : "",
                viewMode === 'compact' ? "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2" : "",
              )}>
                {sortedResultOrder.map(entry => {
                  if (entry.type === 'property') {
                    const prop = propertyMap.get(entry.id);
                    if (!prop) return null;
                    return (
                      <div key={prop.id} onMouseEnter={() => handleCardHover({ id: prop.id, type: 'property', lat: prop.latitude, lon: prop.longitude, title: prop.title ?? '', price: prop.price ?? 0, image: prop.images?.[0]?.image_url, location: prop.location_text ?? '' })} onMouseLeave={handleCardLeave}>
                        <PropertyCard property={prop} />
                      </div>
                    );
                  } else {
                    const proj = projectMap.get(entry.id);
                    if (!proj) return null;
                    return (
                      <div key={`proj_${proj.id}`} onMouseEnter={() => handleCardHover({ id: proj.id, type: 'project', lat: proj.latitude, lon: proj.longitude, title: proj.name, price: proj.low_price ?? 0, image: proj.primary_image ?? undefined, location: proj.location_name ?? '' })} onMouseLeave={handleCardLeave}>
                        <ProjectCard project={proj} />
                      </div>
                    );
                  }
                })}
              </div>
            ) : (
              <>
                {searchScope !== 'projects' && properties.length > 0 && (
                  <div className={cn(
                    viewMode === 'list' ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : "",
                    viewMode === 'grid' ? "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" : "",
                    viewMode === 'compact' ? "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2" : "",
                  )}>
                    {properties.map(property => (
                      <div key={property.id} onMouseEnter={() => handleCardHover({ id: property.id, type: 'property', lat: property.latitude, lon: property.longitude, title: property.title ?? '', price: property.price ?? 0, image: property.images?.[0]?.image_url, location: property.location_text ?? '' })} onMouseLeave={handleCardLeave}>
                        <PropertyCard property={property} />
                      </div>
                    ))}
                  </div>
                )}
                {searchScope !== 'properties' && projects.length > 0 && (
                  <div className={cn(
                    viewMode === 'list' ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : "",
                    viewMode === 'grid' ? "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3" : "",
                    viewMode === 'compact' ? "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2" : "",
                  )}>
                    {viewMode === 'list' && projects.length > 0 && properties.length > 0 && (
                      <div className="border-t border-shadow-dark/10 pt-3 mt-3 col-span-full" />
                    )}
                    {projects.map(proj => (
                      <div key={proj.id} onMouseEnter={() => handleCardHover({ id: proj.id, type: 'project', lat: proj.latitude, lon: proj.longitude, title: proj.name, price: proj.low_price ?? 0, image: proj.primary_image ?? undefined, location: proj.location_name ?? '' })} onMouseLeave={handleCardLeave}>
                        <ProjectCard project={proj} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
                {(properties.length > 0 || projects.length > 0) && (
                  <div className="pt-4">
                    {(searchScope === 'both' && combinedNextCursor) ||
                     (searchScope !== 'projects' && hasMoreProperties) ||
                     (searchScope !== 'properties' && hasMoreProjects) ? (
                      <button
                        onClick={loadMore}
                        disabled={loadingMore}
                        className="neumorphic-button w-full flex items-center justify-center gap-2 text-sm"
                      >
                        {loadingMore ? <FaSpinner className="animate-spin" /> : null}
                        {loadingMore ? 'Loading...' : 'Load More'}
                      </button>
                    ) : (
                      <p className="text-center text-xs text-text-color-light">All results loaded</p>
                    )}
                  </div>
                )}
                {combinedList.length === 0 && !loading && (
                  <div className="text-center mt-10 space-y-1">
                    <p className="text-text-color-light">No results found. Try moving the map or changing filters.</p>
                    {withoutPurposeTotal != null && withoutPurposeTotal > 0 && (
                      <p className="text-sm text-text-color-light">
                        {withoutPurposeTotal} nearby {withoutPurposeTotal === 1 ? 'listing is' : 'listings are'} under a different listing type — try {intent === 'rent' ? 'Buy' : 'Rent'}.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          </div>
        </aside>

        {/* RESIZE HANDLE */}
        {!fullScreenResults && (
          <div
            ref={resizerRef}
            className="w-1.5 cursor-col-resize hover:w-2 hover:bg-blue-400/40 bg-transparent transition-all duration-150 flex-shrink-0 relative z-10 group"
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-shadow-dark/10 group-hover:bg-blue-400/60 transition-colors" />
          </div>
        )}

        {/* MAP */}
        <main className={cn(
          "flex-1 relative transition-all duration-300 ease-in-out",
          "md:flex",
          fullScreenResults ? "opacity-0 pointer-events-none overflow-hidden md:w-0 md:flex-none" : "opacity-100 md:flex-1",
          mobileView === 'map' ? "flex" : "hidden"
        )}>
          <div ref={mapContainer} className="w-full h-full" />
          {loading && <div className="absolute top-4 right-4 bg-bg-color p-2 rounded-full shadow-neumorphic-outset"><FaSpinner className="animate-spin text-blue-500" /></div>}
          {/* Top map status stack: homes count with the active state/emirate
              boundary control beside it (highlighted while a state filter is
              active; its X removes the boundary), community pills below. */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 pointer-events-none">
            <div className="flex items-center gap-2">
              {!loading && (propertyTotal + projectTotal) > 0 && (
                <div className="rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                  {markerCount} of {(propertyTotal + projectTotal).toLocaleString()}{totalRelation === 'gte' ? '+' : ''} homes
                </div>
              )}
              {/* Single boundary control (top of the map): idle → Draw
                  Boundary; drawing → point count + Apply/Cancel; active →
                  boundary name + remove (×). Text-first, no polygon glyphs. */}
              {isDrawingMode ? (
                <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-blue-600 py-1 pl-3 pr-1 text-white shadow-lg">
                  <span className="text-xs font-semibold">
                    {boundaryPoints.length >= 3 ? `${boundaryPoints.length} points` : 'Draw on map (min 3 points)'}
                  </span>
                  <button
                    type="button"
                    onClick={applyBoundary}
                    disabled={boundaryPoints.length < 3}
                    className="rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-white/30 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={cancelDrawing}
                    aria-label="Cancel drawing"
                    title="Cancel drawing"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" />
                      <line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  </button>
                </div>
              ) : boundaryLabel ? (
                <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-blue-600 py-1 pl-3 pr-1 text-white shadow-lg">
                  <span className="max-w-[200px] truncate text-xs font-semibold">{boundaryLabel}</span>
                  <button
                    type="button"
                    onClick={removeActiveBoundary}
                    aria-label={selectedState ? `Clear ${selectedState.name} selection` : `Remove ${boundaryLabel}`}
                    title="Remove boundary"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" />
                      <line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={activateDrawing}
                  aria-label="Draw boundary"
                  title="Draw a custom boundary on the map"
                  className="pointer-events-auto rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm transition-colors hover:bg-black/80"
                >
                  Draw Boundary
                </button>
              )}
            </div>
            {!loading && (propertyTotal + projectTotal) > 0 && projectGroups.length > 0 && (
              <div className="flex flex-wrap justify-center gap-1 max-w-md pointer-events-auto">
                {projectGroups.slice(0, 3).map(g => (
                  <span key={g.name} className="rounded-full bg-red-800/90 px-2 py-0.5 text-[11px] font-semibold text-white">
                    {g.count} in {g.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          {!sidebarOpen && !fullScreenResults && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Show filters sidebar"
              className="hidden md:flex absolute top-4 left-4 z-20 items-center gap-2 rounded-2xl bg-bg-color/95 px-4 py-3 text-sm font-semibold text-text-color-dark shadow-neumorphic-outset backdrop-blur-sm hover:bg-white transition-colors"
            >
              {sidebarToggleIcon}
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}
        </main>
      </div>

      {/* MOBILE TOGGLE */}
      <div className="md:hidden fixed bottom-6 right-6 z-20">
        <button onClick={() => setMobileView(v => v === 'list' ? 'map' : 'list')} className="neumorphic-button flex items-center justify-center gap-2 bg-cta-gradient py-3 px-4 rounded-full">
          {mobileView === 'list' ? <FaMap/> : <FaList/>}
          <span>{mobileView === 'list' ? 'Map' : 'List'}</span>
        </button>
      </div>
    </div>
  );
}
