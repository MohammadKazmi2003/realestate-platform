'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
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
import { MapClustering, type ClusterPoint, type ResultFeature } from '@/lib/map/clustering';
import { setupMapLayers, updateSourceData, updateCircleRadius, highlightFeature, removeMapLayers } from '@/lib/map/mapLayers';
import { showPropertyPreview, hidePropertyPreview, showClusterPreview, hideClusterPreview, destroyPreviewCards } from '@/lib/map/previewCard';
import type { Feature } from 'geojson';

type PropertyBrowse = PropertyCardProps['property'] & {
  latitude: number | null;
  longitude: number | null;
};

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };
type SearchScope = 'properties' | 'projects' | 'both';
type SortOption = 'relevance' | 'popular' | 'newest' | 'price_asc' | 'price_desc';

type ProjectBrowse = Project & {
  latitude: number | null;
  longitude: number | null;
};

const DEFAULT_CENTER: [number, number] = [77.0266, 28.4595];
const MAX_LIST_ITEMS = 500;
const DEFAULT_ZOOM = 11;
const PROJECT_MARKER_COLOR = '#059669';

type AutocompleteSuggestion = {
  type: 'location' | 'property' | 'project' | 'geocoded';
  text: string;
  entity: string;
  bbox?: number[];
  center?: number[];
  polygons?: { lat: number; lng: number }[][];
};

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

// B4: point-in-polygon test (ray casting) for client-side boundary filtering
function pointInPolygonClient(lat: number, lng: number, polygon: { lat: number; lng: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

export default function BrowsePage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const clusteringRef = useRef<MapClustering | null>(null);
  const router = useRouter();

  const [properties, setProperties] = useState<PropertyBrowse[]>([]);
  const [projects, setProjects] = useState<ProjectBrowse[]>([]);
  const [projectTotal, setProjectTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [filterOpen, setFilterOpen] = useState(true);
  const [fullScreenResults, setFullScreenResults] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'compact'>('list');
  const [sortBy, setSortBy] = useState<SortOption>('relevance');
  const [panelWidth, setPanelWidth] = useState(450);
  const sortByRef = useRef(sortBy);
  const resizerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [searchAsIMove, setSearchAsIMove] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [searchScope, setSearchScope] = useState<SearchScope>('both');
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
  const [propertyNextCursor, setPropertyNextCursor] = useState<any[] | null>(null);
  const [projectNextCursor, setProjectNextCursor] = useState<any[] | null>(null);
  const [hasMoreProperties, setHasMoreProperties] = useState(false);
  const [hasMoreProjects, setHasMoreProjects] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sortedResultOrder, setSortedResultOrder] = useState<{ type: 'property' | 'project'; id: string }[]>([]);
  const [combinedNextCursor, setCombinedNextCursor] = useState<any[] | null>(null);
  const isFetchingRef = useRef(false);

  const [boundaryPoints, setBoundaryPoints] = useState<{ lat: number; lng: number }[]>([]);
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [boundaryActive, setBoundaryActive] = useState(false);
  const boundarySourceRef = useRef<maplibregl.GeoJSONSource | null>(null);
  const isDrawingRef = useRef(false);
  const drawPointsRef = useRef<{ lat: number; lng: number }[]>([]);
  const isDrawingModeRef = useRef(false);
  const boundaryActiveRef = useRef(false);
  const updateBoundaryLayerRef = useRef<(points: { lat: number; lng: number }[], isActive?: boolean) => void>(() => {});

  const fetchPropertiesRef = useRef<typeof fetchAllProperties>(() => Promise.resolve());
  const searchAsIMoveRef = useRef(searchAsIMove);
  const searchScopeRef = useRef(searchScope);
  const fullScreenResultsRef = useRef(fullScreenResults);
  const fetchIdRef = useRef(0);
  const initialMoveEndRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);
  const autocompleteReqIdRef = useRef(0);  // A5: stale-response guard for autocomplete
  const clustersFetchIdRef = useRef(0);    // B8: stale-response guard for clusters
  const filtersRef = useRef(filters);
  const pendingFetchRef = useRef<{ bounds: any; cursorOverride?: any; polygonOverride?: any } | null>(null);
  const fetchClustersAbortRef = useRef<AbortController | null>(null);

  searchAsIMoveRef.current = searchAsIMove;
  searchScopeRef.current = searchScope;
  sortByRef.current = sortBy;
  fullScreenResultsRef.current = fullScreenResults;
  isDrawingModeRef.current = isDrawingMode;
  boundaryActiveRef.current = boundaryActive;

  // A6: Sync filtersRef after render (not during render) — prevents stale reads
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

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
    if (value.length >= 3) {
      debounceTimer.current = setTimeout(async () => {
        if (autocompleteAbortRef.current) autocompleteAbortRef.current.abort();
        const controller = new AbortController();
        autocompleteAbortRef.current = controller;
        const reqId = ++autocompleteReqIdRef.current;
        try {
          const result = await autocompleteSearch(value, controller.signal, searchScopeRef.current);
          // A5: ignore stale responses — only apply if this is the latest request
          if (reqId !== autocompleteReqIdRef.current) return;
          if (result?.suggestions) {
            setSuggestions(result.suggestions);
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

  const selectSuggestion = (suggestion: string | AutocompleteSuggestion) => {
    // A5: cancel any in-flight autocomplete + pending debounce before selecting
    cancelAutocomplete();
    const text = typeof suggestion === 'string' ? suggestion : suggestion.text;
    setFilters(prev => ({ ...prev, location: text }));
    setShowSuggestions(false);
    setSuggestions([]);

    const sug = typeof suggestion === 'object' ? suggestion : null;

    // Use actual polygon geometry if available (from two-step geocoding)
    if (sug && sug.polygons && sug.polygons[0]?.length > 0) {
      // Use the largest polygon ring by point count (most accurate for the administrative area).
      // For MultiPolygon features like Mumbai Suburban District, this picks the main district
      // area (1093 points) instead of a tiny island fragment (16 points).
      const boundaryPoints = sug.polygons.reduce((largest, ring) =>
        ring.length > largest.length ? ring : largest
      );

      // Use MapTiler bbox for viewport fitting (covers full geographic extent,
      // more accurate than polygon[0] bounds for MultiPolygon features)
      const bounds = (sug.bbox && sug.bbox.length === 4)
        ? { minLng: sug.bbox[0], minLat: sug.bbox[1], maxLng: sug.bbox[2], maxLat: sug.bbox[3] }
        : { minLat: Math.min(...boundaryPoints.map(p => p.lat)),
            maxLat: Math.max(...boundaryPoints.map(p => p.lat)),
            minLng: Math.min(...boundaryPoints.map(p => p.lng)),
            maxLng: Math.max(...boundaryPoints.map(p => p.lng)) };

      geocodedBoundsRef.current = bounds;

      drawPointsRef.current = boundaryPoints;
      setBoundaryPoints(boundaryPoints);
      setBoundaryActive(true);
      updateBoundaryLayerRef.current(boundaryPoints, true);

      if (mapRef.current) {
        mapRef.current.fitBounds(
          [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat],
          { padding: 40, duration: 800 }
        );
      }
    } else if (sug?.bbox && sug.bbox.length === 4) {
      // Fallback: bbox rectangle when no polygon geometry is available
      const [west, south, east, north] = sug.bbox;
      geocodedBoundsRef.current = { minLat: south, maxLat: north, minLng: west, maxLng: east };

      const boundaryPoints = [
        { lat: north, lng: west },
        { lat: north, lng: east },
        { lat: south, lng: east },
        { lat: south, lng: west },
      ];
      drawPointsRef.current = boundaryPoints;
      setBoundaryPoints(boundaryPoints);
      setBoundaryActive(true);
      updateBoundaryLayerRef.current(boundaryPoints, true);

      if (mapRef.current) {
        mapRef.current.fitBounds([west, south, east, north], { padding: 40, duration: 800 });
      }
    } else if (sug?.center) {
      const [lng, lat] = sug.center;
      geocodedBoundsRef.current = { minLat: lat - 0.1, maxLat: lat + 0.1, minLng: lng - 0.1, maxLng: lng + 0.1 };
    }

    handleApplyFiltersWithLocation(text);
  };

  const projectSortForBrowse = (sort: SortOption): string => {
    if (sort === 'popular') return 'relevance';
    if (sort === 'newest') return 'date_desc';
    if (sort === 'price_asc') return 'price_asc';
    if (sort === 'price_desc') return 'price_desc';
    return 'relevance';
  };

  const fetchAllProperties = useCallback(async (bounds: LngLatBounds | null, cursorOverride?: { propertyCursor?: any[] | null; projectCursor?: any[] | null; append?: boolean }, polygonOverride?: { lat: number; lng: number }[] | null) => {
    if (isFetchingRef.current) {
      pendingFetchRef.current = { bounds, cursorOverride, polygonOverride };
      return;
    }
    isFetchingRef.current = true;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    const fetchId = ++fetchIdRef.current;
    const isAppend = cursorOverride?.append ?? false;
    if (!isAppend) setLoading(true);
    else setLoadingMore(true);

    const scope = searchScopeRef.current;
    const isListView = fullScreenResultsRef.current;
    const { bhkIdToLabel, propTypeIdToName } = lookupMaps;
    const activeFilters = filtersRef.current;
    // Dynamic page size: 100 at far zoom (clusters dominate, fewer cards needed),
    // 500 at close zoom (individual markers and supercluster need full dataset)
    const currentZoom = mapRef.current ? mapRef.current.getZoom() : 12;
    const mapPageSize = currentZoom <= 13 ? 100 : 500;
    const params: any = { pageSize: isAppend ? 24 : mapPageSize, sort: sortByRef.current };

    if (activeFilters.location) params.location = activeFilters.location;
    if (activeFilters.minPrice) params.minPrice = Number(activeFilters.minPrice);
    if (activeFilters.maxPrice) params.maxPrice = Number(activeFilters.maxPrice);
    if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
      params.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
    }
    if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
      params.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
    }

    const activePolygon = polygonOverride ?? (boundaryActiveRef.current ? boundaryPoints : null);
    if (activePolygon && activePolygon.length >= 3) {
      params.polygon = activePolygon;
    }
    if (searchAsIMoveRef.current && bounds && !isListView) {
      const minLat = bounds.getSouthWest().lat;
      const maxLat = bounds.getNorthEast().lat;
      const minLng = bounds.getSouthWest().lng;
      const maxLng = bounds.getNorthEast().lng;
      if (isFinite(minLat) && isFinite(maxLat) && isFinite(minLng) && isFinite(maxLng)) {
        params.bounds = { minLat, maxLat, minLng, maxLng };
      }
    }

    if (cursorOverride?.propertyCursor && (scope === 'properties' || scope === 'both')) {
      params.cursor = cursorOverride.propertyCursor;
    }

    try {
      if (!isAppend) {
        // FRESH LOAD: Use combined /api/map-data endpoint (clusters + listings in 1 request)
        const currentZoom = mapRef.current ? Math.round(mapRef.current.getZoom()) : 12;
        const combinedParams: any = {
          bounds: params.bounds,
          zoom: currentZoom,
          scope,
          query: activeFilters.location || undefined,
          minPrice: activeFilters.minPrice ? Number(activeFilters.minPrice) : undefined,
          maxPrice: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : undefined,
          pageSize: 500,
          sort: sortByRef.current,
        };
        if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
          combinedParams.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
        }
        if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
          combinedParams.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
        }
        if (params.polygon) {
          combinedParams.polygon = params.polygon;
        }

        const res = await fetch('/api/map-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(combinedParams),
          signal,
        });
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
                delivery_date: r.delivery_date || null,
                developer_name: r.developer_name || '',
                primary_image: r.image_url || null,
                location_name: r.location_text || null,
                latitude: loc.lat ?? null,
                longitude: loc.lon ?? null,
              };
              projs.push(mapped);
              order.push({ type: 'project', id: r.id });
            }
          }

          // Build map GeoJSON: ES result individual markers + optional H3 clusters
          if (mapRef.current) {
            const mapFeatures: GeoJSON.Feature[] = [];
            const hasPropertySpecificFilters = !!(combinedParams.bhkType || combinedParams.propertyType);

            // H3 cluster circles — only when clusters exist AND no property-specific filters
            // (ClickHouse property_type/bhk_type data may differ from ES, causing count mismatches)
            if (!hasPropertySpecificFilters && response.clusters?.length > 0) {
              const merged = mergeOverlappingClusters(response.clusters, 70, mapRef.current);
              for (let i = 0; i < merged.length; i++) {
                const c = merged[i];
                if (c.count <= 1) continue;
                mapFeatures.push({
                  type: 'Feature' as const,
                  geometry: { type: 'Point' as const, coordinates: [c.center_lon || c.lon, c.center_lat || c.lat] },
                  properties: {
                    point_count: c.count,
                    point_count_abbreviated: c.count >= 10000 ? `${Math.round(c.count / 1000)}k` : c.count >= 1000 ? `${(c.count / 1000).toFixed(1)}k` : c.count.toString(),
                    avg_price: c.avg_price, min_price: c.min_price, max_price: c.max_price,
                    _index: i,
                  },
                });
              }
            }

            // ES result individual markers (no point_count → rendered by unclustered layers)
            for (const r of (response.results || [])) {
              const loc = r.location;
              if (!loc?.lat || !loc?.lon) continue;
              const img = r.image_url || r.primary_image || '';
              const title = r.entity_type === 'project' ? (r.name || '') : (r.title || '');
              mapFeatures.push({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [loc.lon, loc.lat] },
                properties: {
                  id: r.id,
                  type: r.entity_type === 'project' ? 'project' : 'property',
                  title,
                  price: r.entity_type === 'project' ? (r.low_price || 0) : (r.sort_price || r.price || 0),
                  image: img,
                  location: r.location_text || '',
                  area: r.area_sqft ? `${r.area_sqft} sqft` : undefined,
                  bedrooms: r.bhk_type || undefined,
                  bathrooms: r.bathrooms?.toString(),
                },
              });
            }

            const geojson: GeoJSON.FeatureCollection = {
              type: 'FeatureCollection',
              features: mapFeatures,
            };
            updateSourceData(mapRef.current, geojson);
            updateCircleRadius(mapRef.current, mapRef.current.getZoom());
          }

          if (fetchId !== fetchIdRef.current) return;

          setProperties(props);
          setProjects(projs);
          setSortedResultOrder(order);
          setPropertyTotal(response.propertyTotal ?? 0);
          setProjectTotal(response.projectTotal ?? 0);
          setCombinedNextCursor(response.nextCursor ?? null);
        }
      } else if (scope === 'both' && isAppend) {
        // APPEND: Use existing /api/search endpoint for pagination
        const combinedParams: any = {
          scope: 'both',
          query: activeFilters.location || undefined,
          minPrice: activeFilters.minPrice ? Number(activeFilters.minPrice) : undefined,
          maxPrice: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : undefined,
          pageSize: 24,
          sort: sortByRef.current,
        };
        if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
          combinedParams.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
        }
        if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
          combinedParams.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
        }
        if (params.bounds) combinedParams.bounds = params.bounds;
        // Forward polygon boundary to Load More results — without this,
        // paginated results ignore the active boundary
        if (params.polygon) {
          combinedParams.polygon = params.polygon;
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
                delivery_date: r.delivery_date || null,
                developer_name: r.developer_name || '',
                primary_image: r.image_url || null,
                location_name: r.location_text || null,
                latitude: loc.lat ?? null,
                longitude: loc.lon ?? null,
              };
              projs.push(mapped);
              order.push({ type: 'project', id: r.id });
            }
          }

          // Cap arrays to prevent unbounded memory growth during infinite scroll
          setProperties(prev => [...prev, ...props].slice(-MAX_LIST_ITEMS));
          setProjects(prev => [...prev, ...projs].slice(-MAX_LIST_ITEMS));
          setSortedResultOrder(prev => [...prev, ...order].slice(-MAX_LIST_ITEMS));
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
          polygon: params.polygon,
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
          delivery_date: r.delivery_date || null,
          developer_name: r.developer_name || '',
          primary_image: r.primary_image || null,
          location_name: r.location_name || null,
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
        }));
        if (isAppend) {
          setProjects(prev => [...prev, ...mapped].slice(-MAX_LIST_ITEMS));
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
            setProperties(prev => [...prev, ...formattedData].slice(-MAX_LIST_ITEMS));
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
      isFetchingRef.current = false;
      if (pendingFetchRef.current) {
        const pending = pendingFetchRef.current;
        pendingFetchRef.current = null;
        fetchAllProperties(pending.bounds, pending.cursorOverride, pending.polygonOverride);
      }
    }
    if (fetchId === fetchIdRef.current) {
      if (isAppend) setLoadingMore(false);
      else setLoading(false);
    }
  }, [filters, lookupMaps, boundaryActive, boundaryPoints]);

  fetchPropertiesRef.current = fetchAllProperties;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const highlightMarker = useCallback((id: string | null) => {
    if (mapRef.current) {
      highlightFeature(mapRef.current, id);
    }
  }, []);

  const mergeOverlappingClusters = useCallback((clusters: any[], minPixelDistance: number, map: maplibregl.Map) => {
    if (clusters.length <= 1) return clusters;

    const sorted = [...clusters].sort((a: any, b: any) => (b.count || 0) - (a.count || 0));
    const merged: any[] = [];
    const used = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;

      const group = [sorted[i]];
      const pi = map.project(
        new maplibregl.LngLat(sorted[i].center_lon || sorted[i].lon, sorted[i].center_lat || sorted[i].lat)
      );

      for (let j = i + 1; j < sorted.length; j++) {
        if (used.has(j)) continue;
        const pj = map.project(
          new maplibregl.LngLat(sorted[j].center_lon || sorted[j].lon, sorted[j].center_lat || sorted[j].lat)
        );
        const dx = pi.x - pj.x;
        const dy = pi.y - pj.y;
        if (Math.sqrt(dx * dx + dy * dy) < minPixelDistance) {
          group.push(sorted[j]);
          used.add(j);
        }
      }

      if (group.length === 1) {
        merged.push(group[0]);
      } else {
        const totalCount = group.reduce((s: number, c: any) => s + (c.count || 0), 0);
        const totalWeightedLat = group.reduce((s: number, c: any) => s + (c.center_lat || c.lat || 0) * (c.count || 0), 0);
        const totalWeightedLon = group.reduce((s: number, c: any) => s + (c.center_lon || c.lon || 0) * (c.count || 0), 0);
        merged.push({
          ...group[0],
          center_lat: totalWeightedLat / totalCount,
          center_lon: totalWeightedLon / totalCount,
          count: totalCount,
          avg_price: Math.round(group.reduce((s: number, c: any) => s + (c.avg_price || 0) * (c.count || 0), 0) / totalCount),
          min_price: Math.min(...group.map((c: any) => c.min_price || Infinity)),
          max_price: Math.max(...group.map((c: any) => c.max_price || 0)),
        });
      }
    }
    return merged;
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

  const combinedList = useMemo(() => {
    if (searchScope === 'both') {
      return [...properties.map(p => ({ type: 'property' as const, data: p })), ...projects.map(p => ({ type: 'project' as const, data: p }))];
    }
    if (searchScope === 'projects') return projects.map(p => ({ type: 'project' as const, data: p }));
    return properties.map(p => ({ type: 'property' as const, data: p }));
  }, [properties, projects, searchScope]);

  const buildFeatures = useCallback((): ClusterPoint[] => {
    const features: ClusterPoint[] = [];
    for (const p of properties) {
      if (p.latitude != null && p.longitude != null && !isNaN(p.latitude) && !isNaN(p.longitude)) {
        features.push({
          id: p.id, type: 'property', title: p.title || '', price: p.price || 0,
          image: p.images?.[0]?.image_url || '', location: p.location_text || '',
          area: p.area ? `${p.area} ${p.area_unit || 'sqft'}` : undefined,
          bedrooms: p.bhk_type_label || undefined, bathrooms: p.bathrooms?.toString(),
          latitude: p.latitude, longitude: p.longitude,
        });
      }
    }
    for (const p of projects) {
      if (p.latitude != null && p.longitude != null && !isNaN(p.latitude) && !isNaN(p.longitude)) {
        features.push({
          id: p.id, type: 'project', title: p.name, price: p.low_price || 0,
          image: p.primary_image || '', location: p.location_name || '',
          latitude: p.latitude, longitude: p.longitude,
        });
      }
    }
    return features;
  }, [properties, projects]);

  const updateClusters = useCallback(() => {
    const map = mapRef.current;
    const clustering = clusteringRef.current;
    if (!map || !clustering) return;

    const bounds = map.getBounds();
    const zoom = Math.round(map.getZoom());  // B9: single rounded zoom for consistency

    if (zoom <= 13) {
      // FAR ZOOM: Server-side clustering via ClickHouse ES geohash_grid
      if (fetchClustersAbortRef.current) fetchClustersAbortRef.current.abort();
      const controller = new AbortController();
      fetchClustersAbortRef.current = controller;
      const clusterFetchId = ++clustersFetchIdRef.current;  // B8: freshness guard

      const activeFilters = filtersRef.current;
      const { bhkIdToLabel, propTypeIdToName } = lookupMaps;
      const bbox = {
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
      };
      const filterParams: any = {};
      if (activeFilters.minPrice) filterParams.minPrice = Number(activeFilters.minPrice);
      if (activeFilters.maxPrice) filterParams.maxPrice = Number(activeFilters.maxPrice);
      if (activeFilters.bhkTypeId && bhkIdToLabel[Number(activeFilters.bhkTypeId)]) {
        filterParams.bhkType = bhkIdToLabel[Number(activeFilters.bhkTypeId)];
      }
      if (activeFilters.propertyTypeId && propTypeIdToName[Number(activeFilters.propertyTypeId)]) {
        filterParams.propertyType = propTypeIdToName[Number(activeFilters.propertyTypeId)];
      }
      if (activeFilters.location) filterParams.location = activeFilters.location;  // B2: forward location text

      const clusterBody: any = { bounds: bbox, zoom, filters: filterParams, scope: searchScopeRef.current };
      if (boundaryActiveRef.current && drawPointsRef.current.length >= 3) {
        clusterBody.polygon = drawPointsRef.current;
      }

      fetch('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clusterBody),
        signal: controller.signal,
      }).then(res => res.json()).then((data) => {
        if (!data || !data.clusters || !mapRef.current) return;
        // B8: ignore stale responses (a newer cluster fetch has started)
        if (clusterFetchId !== clustersFetchIdRef.current) return;
        const zoomLvl = mapRef.current.getZoom();
        if (Math.round(zoomLvl) !== zoom) return; // stale zoom

        const merged = mergeOverlappingClusters(data.clusters, 70, mapRef.current);
        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: merged.map((c: any, i: number) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [c.center_lon || c.lon, c.center_lat || c.lat] },
            properties: {
              point_count: c.count,
              point_count_abbreviated: c.count >= 10000 ? `${Math.round(c.count / 1000)}k` : c.count >= 1000 ? `${(c.count / 1000).toFixed(1)}k` : c.count.toString(),
              avg_price: c.avg_price, min_price: c.min_price, max_price: c.max_price,
              types: c.types, _index: i,
            },
          })),
        };
        updateSourceData(mapRef.current, geojson);
        updateCircleRadius(mapRef.current, zoomLvl);
      }).catch(() => {});
    } else {
      // CLOSE ZOOM: Client-side clustering via supercluster in Web Worker
      // (keeps main thread free for 60fps map rendering)
      let features = buildFeatures();

      // B4: If a boundary is active, filter points by polygon BEFORE clustering.
      // Server-side clusters use centroid approximation; here we can be exact.
      const poly = boundaryActiveRef.current && drawPointsRef.current.length >= 3
        ? drawPointsRef.current
        : null;
      if (poly) {
        features = features.filter(p =>
          pointInPolygonClient(p.latitude, p.longitude, poly)
        );
      }

      const bbox: [number, number, number, number] = [
        bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
      ];

      // Fallback: run on main thread if worker unavailable (dev mode, SSR, etc.)
      if (typeof Worker === 'undefined') {
        clustering.load(features);
        const clusters = clustering.getClusters(bbox, zoom);
        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: clusters.map((f, i) => ({
            type: 'Feature' as const,
            geometry: f.geometry,
            properties: { ...f.properties, _index: i },
          })),
        };
        updateSourceData(map, geojson);
        updateCircleRadius(map, zoom);
        return;
      }

      const worker = new Worker(new URL('@/lib/map/clusterWorker', import.meta.url));
      worker.postMessage({ type: 'cluster', features, bbox, zoom });
      worker.onmessage = (e: MessageEvent) => {
        const clusters: any[] = e.data.clusters || [];
        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: clusters.map((f: any, i: number) => ({
            type: 'Feature' as const,
            geometry: f.geometry,
            properties: { ...f.properties, _index: i },
          })),
        };
        updateSourceData(map, geojson);
        updateCircleRadius(map, zoom);
        worker.terminate();
      };
      worker.onerror = () => {
        // Worker failed, fall back to main thread
        clustering.load(features);
        const clusters = clustering.getClusters(bbox, zoom);
        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: clusters.map((f, i) => ({
            type: 'Feature' as const,
            geometry: f.geometry,
            properties: { ...f.properties, _index: i },
          })),
        };
        updateSourceData(map, geojson);
        updateCircleRadius(map, zoom);
      };
    }
  }, [buildFeatures, mergeOverlappingClusters, lookupMaps]);

  useEffect(() => {
    // Always update clusters when properties/projects change.
    // updateClusters() handles polygon filtering via /api/clusters when boundary is active.
    // Skipping it when boundary is active caused unfiltered clusters from /api/map-data to persist.
    updateClusters();
  }, [properties, projects, updateClusters]);

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
    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    const onPointMouseMove = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties as any;
      if (props.cluster) return;
      map.getCanvas().style.cursor = 'pointer';
      const point: ClusterPoint = {
        id: props.id, type: props.type, title: props.title, price: props.price || 0,
        image: props.image || '', location: props.location || '',
        area: props.area, bedrooms: props.bedrooms,
        latitude: e.lngLat.lat, longitude: e.lngLat.lng,
      };
      showPropertyPreview(map, point, e.lngLat);
    };

    const onPointMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      hidePropertyPreview();
    };

    const onPointClick = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const props = feature.properties as any;
      if (props.type === 'project') {
        router.push(`/projects/${props.id}`);
      } else {
        router.push(`/property/${props.id}`);
      }
    };

    const onClusterMouseMove = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature || !clusteringRef.current) return;
      const props = feature.properties as any;
      if (!props.cluster) return;
      map.getCanvas().style.cursor = 'pointer';
      const totalCount = props.point_count || 0;
      const currentZoom = map.getZoom();
      if (currentZoom <= 13) {
        showClusterPreview(map, [], totalCount, e.lngLat, () => {
          map.flyTo({ center: e.lngLat.toArray() as [number, number], zoom: map.getZoom() + 2, duration: 500 });
        }, props.avg_price, props.min_price, props.max_price);
      } else {
        const leaves = clusteringRef.current.getLeaves(props.cluster_id, 5);
        const leafPoints: ClusterPoint[] = leaves.map((l) => ({
          id: l.properties.id, type: l.properties.type, title: l.properties.title,
          price: l.properties.price || 0, image: l.properties.image || '',
          location: l.properties.location || '',
          latitude: l.geometry.coordinates[1], longitude: l.geometry.coordinates[0],
        }));
        showClusterPreview(map, leafPoints, totalCount, e.lngLat, () => {
          map.flyTo({ center: e.lngLat.toArray() as [number, number], zoom: map.getZoom() + 2, duration: 500 });
        }, props.avg_price, props.min_price, props.max_price);
      }
    };

    const onClusterMouseLeave = () => {
      map.getCanvas().style.cursor = '';
      hideClusterPreview();
    };

    const onClusterClick = (e: maplibregl.MapMouseEvent & { features?: Feature[] }) => {
      const feature = e.features?.[0];
      if (!feature || !clusteringRef.current) return;
      const props = feature.properties as any;
      if (!props.cluster) return;
      const zoom = clusteringRef.current.getClusterExpansionZoom(props.cluster_id);
      map.flyTo({ center: (feature.geometry as any).coordinates, zoom: zoom + 1 });
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
      if (drawPointsRef.current.length >= 3) {
        updateBoundaryLayerRef.current(drawPointsRef.current, true);
        // Also fit viewport to the geocoded boundary (was skipped because mapRef was null)
        if (geocodedBoundsRef.current) {
          const b = geocodedBoundsRef.current;
          setTimeout(() => {
            map.fitBounds([b.minLng, b.minLat, b.maxLng, b.maxLat], { padding: 40, duration: 0 });
          }, 200);
        }
      }

      setupMapLayers(map);
      clusteringRef.current = new MapClustering();

      map.on('mousemove', 'unclustered-properties', onPointMouseMove);
      map.on('mousemove', 'unclustered-projects', onPointMouseMove);
      map.on('mouseleave', 'unclustered-properties', onPointMouseLeave);
      map.on('mouseleave', 'unclustered-projects', onPointMouseLeave);
      map.on('click', 'unclustered-properties', onPointClick);
      map.on('click', 'unclustered-projects', onPointClick);
      map.on('mousemove', 'clusters', onClusterMouseMove);
      map.on('mouseleave', 'clusters', onClusterMouseLeave);
      map.on('click', 'clusters', onClusterClick);

      fetchPropertiesRef.current(map.getBounds());
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
      const currentZoom = Math.round(map.getZoom());  // B9: single rounded zoom

      // If we just completed a geocoded location fitBounds, skip the redundant fetch.
      // The initial fetchAllProperties from selectSuggestion already handles the data.
      if (geocodedBoundsRef.current) {
        geocodedBoundsRef.current = null;
        if (currentZoom <= 13) {
          updateClusters();
        }
        return;
      }

      if (currentZoom <= 13) {
        updateClusters();
      }
      if (searchAsIMoveRef.current) {
        // 1000ms debounce for pan-triggered searches
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          fetchPropertiesRef.current(map.getBounds());
        }, 1000);
      }
    };

    map.on('load', onLoad);
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    map.on('moveend', onMoveEnd);

    return () => {
      map.off('load', onLoad);
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.off('moveend', onMoveEnd);
      map.off('mousemove', 'unclustered-properties', onPointMouseMove);
      map.off('mousemove', 'unclustered-projects', onPointMouseMove);
      map.off('mouseleave', 'unclustered-properties', onPointMouseLeave);
      map.off('mouseleave', 'unclustered-projects', onPointMouseLeave);
      map.off('click', 'unclustered-properties', onPointClick);
      map.off('click', 'unclustered-projects', onPointClick);
      map.off('mousemove', 'clusters', onClusterMouseMove);
      map.off('mouseleave', 'clusters', onClusterMouseLeave);
      map.off('click', 'clusters', onClusterClick);
      removeMapLayers(map);
      destroyPreviewCards();
      clusteringRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    }, [router]);

  useEffect(() => {
    const resizer = resizerRef.current;
    if (!resizer) return;
    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
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

  const handleApplyFiltersWithLocation = async (locationText: string) => {
    // Only geocode if we don't already have bbox from a selected autocomplete suggestion
    if (locationText && process.env.NEXT_PUBLIC_MAPTILER_KEY && !geocodedBoundsRef.current) {
      setSearchAsIMove(true);
      try {
        // Step 1: Forward geocoding — get feature IDs + bbox
        const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(locationText)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}${process.env.NEXT_PUBLIC_GEOCODE_COUNTRIES ? `&country=${process.env.NEXT_PUBLIC_GEOCODE_COUNTRIES}` : ''}&language=en`, { signal: AbortSignal.timeout(3000) });
        const data = await response.json();
        if (data.features && data.features.length > 0) {
          const feature = data.features[0];

          // Step 2: Fetch actual polygon geometry by feature ID
          let polygons: { lat: number; lng: number }[][] | null = null;
          if (feature.id) {
            try {
              const geomResponse = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(feature.id)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}&language=en`, { signal: AbortSignal.timeout(3000) });
              const geomData = await geomResponse.json();
              const geo = geomData.features?.[0]?.geometry;
              if (geo && (geo.type === 'MultiPolygon' || geo.type === 'Polygon')) {
                // Correctly handle both Polygon and MultiPolygon nesting
                const rings = geo.type === 'MultiPolygon'
                  ? geo.coordinates.flatMap((polygon: number[][][]) => polygon)
                  : [geo.coordinates];
                polygons = rings.map((ring: number[][]) => ring.map(([lng, lat]: number[]) => ({ lat, lng })));
              }
            } catch {}
          }

          if (polygons && polygons[0]?.length > 0) {
            // Use the largest polygon ring by point count (most accurate for the area)
            const boundaryPoints = polygons.reduce((largest, ring) =>
              ring.length > largest.length ? ring : largest
            );
            const bounds = {
              minLat: Math.min(...boundaryPoints.map(p => p.lat)),
              maxLat: Math.max(...boundaryPoints.map(p => p.lat)),
              minLng: Math.min(...boundaryPoints.map(p => p.lng)),
              maxLng: Math.max(...boundaryPoints.map(p => p.lng)),
            };
            geocodedBoundsRef.current = bounds;
            drawPointsRef.current = boundaryPoints;
            setBoundaryPoints(boundaryPoints);
            setBoundaryActive(true);
            updateBoundaryLayerRef.current(boundaryPoints, true);
            mapRef.current?.fitBounds([bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat], { padding: 40, duration: 800 });
          } else if (feature.bbox && feature.bbox.length === 4) {
            // Fallback to bbox rectangle
            const [west, south, east, north] = feature.bbox;
            mapRef.current?.fitBounds([west, south, east, north], { padding: 40, duration: 800 });
            const pts = [
              { lat: north, lng: west },
              { lat: north, lng: east },
              { lat: south, lng: east },
              { lat: south, lng: west },
            ];
            drawPointsRef.current = pts;
            setBoundaryPoints(pts);
            setBoundaryActive(true);
            updateBoundaryLayerRef.current(pts, true);
            geocodedBoundsRef.current = { minLat: south, maxLat: north, minLng: west, maxLng: east };
          } else if (feature.center) {
            mapRef.current?.flyTo({ center: feature.center, zoom: 13, essential: true });
            const [lng, lat] = feature.center;
            geocodedBoundsRef.current = { minLat: lat - 0.1, maxLat: lat + 0.1, minLng: lng - 0.1, maxLng: lng + 0.1 };
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
    // Pass the boundary polygon directly as polygonOverride.
    // This avoids the stale closure issue with boundaryActiveRef.
    const polygon = drawPointsRef.current.length >= 3 ? drawPointsRef.current : null;
    fetchAllProperties(searchBounds as any, undefined, polygon);
  };

  const handleApplyFilters = async () => {
    handleApplyFiltersWithLocation(filtersRef.current.location);
  };

  const handleResetFilters = () => {
    const defaultFilters = { location: '', minPrice: '', maxPrice: '', bhkTypeId: '', propertyTypeId: '' };
    filtersRef.current = defaultFilters;
    geocodedBoundsRef.current = null; // Clear any geocoded location
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
    if (mapRef.current) {
      mapRef.current.dragPan.enable();
      mapRef.current.scrollZoom.enable();
      mapRef.current.boxZoom.enable();
      mapRef.current.doubleClickZoom.enable();
      mapRef.current.getCanvas().style.cursor = '';
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    fetchPropertiesRef.current(
      searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
    );
  };

  const loadMore = useCallback(() => {
    const bounds = searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null;
    const scope = searchScopeRef.current;
    if (scope === 'both') {
      if (combinedNextCursor) {
        fetchAllProperties(bounds, {
          propertyCursor: combinedNextCursor,
          append: true,
        });
      }
    } else {
      fetchAllProperties(bounds, {
        propertyCursor: (scope !== 'projects' && hasMoreProperties) ? propertyNextCursor : null,
        projectCursor: (scope !== 'properties' && hasMoreProjects) ? projectNextCursor : null,
        append: true,
      });
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
    setSearchScope(scope);
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

  const updateBoundaryLayer = useCallback((points: { lat: number; lng: number }[], isActive?: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('boundary') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (points.length < 2) {
      src.setData({ type: 'FeatureCollection', features: [] } as any);
      map.setPaintProperty('boundary-fill', 'fill-opacity', 0);
      map.setPaintProperty('boundary-outline', 'line-opacity', 0);
      map.setPaintProperty('boundary-vertices', 'circle-opacity', 0);
      return;
    }
    const coords: [number, number][] = points.map(p => [p.lng, p.lat]);
    // Close the polygon ring (GeoJSON RFC 7946 requires first == last)
    if (coords.length >= 3) {
      coords.push(coords[0]);
    }
    const isClosed = points.length >= 3;
    const geometry = isClosed
      ? { type: 'Polygon' as const, coordinates: [coords] }
      : { type: 'LineString' as const, coordinates: coords };
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] } as any);
    const active = isActive ?? false;
    map.setPaintProperty('boundary-fill', 'fill-opacity', active ? 0.15 : 0.12);
    map.setPaintProperty('boundary-outline', 'line-opacity', 0.8);
    map.setPaintProperty('boundary-outline', 'line-width', active ? 3 : 2);
    map.setPaintProperty('boundary-outline', 'line-dasharray', active ? [1, 0] : [4, 4]);
    map.setPaintProperty('boundary-vertices', 'circle-opacity', 0);
  }, []);

  useEffect(() => {
    updateBoundaryLayerRef.current = updateBoundaryLayer;
  }, [updateBoundaryLayer]);

  const activateDrawing = useCallback(() => {
    setIsDrawingMode(true);
    setBoundaryPoints([]);
    drawPointsRef.current = [];
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
  }, []);

  const cancelDrawing = useCallback(() => {
    setIsDrawingMode(false);
    drawPointsRef.current = [];
    setBoundaryPoints([]);
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
    const pts = drawPointsRef.current;
    if (pts.length < 3) return;
    const simplified = simplifyPolygon(pts);
    drawPointsRef.current = simplified;
    setBoundaryPoints(simplified);
    setBoundaryActive(true);
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
    fetchPropertiesRef.current(bounds, undefined, simplified);
  }, [updateBoundaryLayer]);

  const removeBoundary = useCallback(() => {
    setBoundaryActive(false);
    setBoundaryPoints([]);
    setIsDrawingMode(false);
    drawPointsRef.current = [];
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

  const SCOPE_OPTIONS: { value: SearchScope; label: string; icon: React.ReactNode }[] = [
    { value: 'properties', label: 'Properties', icon: <FaHome size={12} /> },
    { value: 'projects', label: 'Projects', icon: <FaBuilding size={12} /> },
    { value: 'both', label: 'Both', icon: null },
  ];

  const chevronDown = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );

  const filterIcon = (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );

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

  return (
    <div className="flex flex-col h-screen bg-bg-color">
      <Header />
      <div className="flex flex-1 overflow-hidden">

        {/* LEFT PANEL: Collapsible Filters + Results */}
        <aside className={cn(
          "bg-bg-color border-r border-shadow-dark/20 flex flex-col transition-all duration-300 ease-in-out",
          "md:flex",
          mobileView === 'list' ? "flex" : "hidden"
        )}
          style={{ width: fullScreenResults ? '100%' : `${panelWidth}px`, maxWidth: fullScreenResults ? '100%' : `${panelWidth}px`, flex: fullScreenResults ? '1 1 auto' : '0 0 auto' }}
        >

          {/* FILTER TOGGLE HEADER */}
          <div className="p-4 pb-2">
            <button
              onClick={() => setFilterOpen(!filterOpen)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-2xl shadow-neumorphic-outset text-sm font-semibold text-text-color-dark hover:bg-shadow-dark/5 transition-colors"
            >
              <span className="flex items-center gap-2">
                {filterIcon}
                Filters
              </span>
              <span className={`transition-transform duration-300 ${filterOpen ? 'rotate-180' : ''}`}>
                {chevronDown}
              </span>
            </button>
          </div>

          {/* FILTER CONTENT (accordion) */}
          <div className={cn(
            "transition-all duration-300 ease-in-out overflow-hidden",
            filterOpen ? "max-h-[700px] opacity-100" : "max-h-0 opacity-0"
          )}>
            <div className="px-4 pb-2">
              <div className="shadow-neumorphic-outset rounded-3xl p-4 space-y-4">

                {/* Scope Selector */}
                <div className="flex gap-1 p-1 rounded-2xl shadow-neumorphic-inset">
                  {SCOPE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleScopeChange(opt.value)}
                      className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2 px-3 rounded-xl transition-all ${
                        searchScope === opt.value
                          ? 'shadow-neumorphic-outset bg-bg-color text-text-color-dark'
                          : 'text-text-color-light hover:text-text-color-dark'
                      }`}
                    >
                      {opt.icon && opt.icon}
                      {opt.label}
                    </button>
                  ))}
                </div>

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
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" name="minPrice" placeholder="Min Price" value={filters.minPrice} onChange={handleFilterChange} className="neumorphic-input w-full"/>
                  <input type="number" name="maxPrice" placeholder="Max Price" value={filters.maxPrice} onChange={handleFilterChange} className="neumorphic-input w-full"/>
                </div>

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

                {/* Draw Boundary */}
                <div>
                  {!isDrawingMode && !boundaryActive && (
                    <button onClick={activateDrawing} className="neumorphic-button w-full flex items-center justify-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2 L22 8.5 L22 15.5 L12 22 L2 15.5 L2 8.5 Z"/>
                        <circle cx="12" cy="12" r="3" fill="currentColor"/>
                      </svg>
                      Draw Boundary
                    </button>
                  )}
                  {isDrawingMode && (
                    <div className="space-y-2">
                      <p className="text-xs text-text-color-light text-center">Click & drag on map to draw a boundary. {boundaryPoints.length >= 3 ? `(${boundaryPoints.length} points)` : '(min 3 points required)'}</p>
                      <div className="flex gap-2">
                        <button onClick={cancelDrawing} className="neumorphic-button flex-1">Cancel</button>
                        <button onClick={applyBoundary} disabled={boundaryPoints.length < 3} className="neumorphic-button bg-cta-gradient flex-1 disabled:opacity-50">Apply</button>
                      </div>
                    </div>
                  )}
                  {boundaryActive && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-success-color">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        Boundary Active ({boundaryPoints.length} pts)
                      </div>
                      <button onClick={removeBoundary} className="neumorphic-button w-full text-danger-color">Remove Boundary</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* RESULTS LIST */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
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
                      <option value="relevance">Relevance</option>
                      <option value="popular">Most Popular</option>
                      <option value="newest">Newest</option>
                      <option value="price_asc">Price Low → High</option>
                      <option value="price_desc">Price High → Low</option>
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
                      <div key={prop.id} onMouseEnter={() => highlightMarker(prop.id)} onMouseLeave={() => highlightMarker(null)}>
                        <PropertyCard property={prop} />
                      </div>
                    );
                  } else {
                    const proj = projectMap.get(entry.id);
                    if (!proj) return null;
                    return (
                      <div key={`proj_${proj.id}`} onMouseEnter={() => highlightMarker(`proj_${proj.id}`)} onMouseLeave={() => highlightMarker(null)}>
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
                      <div key={property.id} onMouseEnter={() => highlightMarker(property.id)} onMouseLeave={() => highlightMarker(null)}>
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
                      <div key={proj.id} onMouseEnter={() => highlightMarker(`proj_${proj.id}`)} onMouseLeave={() => highlightMarker(null)}>
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
                  <p className="text-center text-text-color-light mt-10">No results found. Try moving the map or changing filters.</p>
                )}
              </>
            )}
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
