'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { LngLatBounds } from 'maplibre-gl';
import React, { useEffect, useRef, useState, useCallback } from 'react';
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
const DEFAULT_ZOOM = 11;
const PROJECT_MARKER_COLOR = '#059669';

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

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
  const updateBoundaryLayerRef = useRef<(points: { lat: number; lng: number }[]) => void>(() => {});

  const fetchPropertiesRef = useRef<typeof fetchAllProperties>(() => Promise.resolve());
  const searchAsIMoveRef = useRef(searchAsIMove);
  const searchScopeRef = useRef(searchScope);
  const fullScreenResultsRef = useRef(fullScreenResults);
  const fetchIdRef = useRef(0);
  const initialMoveEndRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);

  searchAsIMoveRef.current = searchAsIMove;
  searchScopeRef.current = searchScope;
  sortByRef.current = sortBy;
  fullScreenResultsRef.current = fullScreenResults;
  isDrawingModeRef.current = isDrawingMode;
  boundaryActiveRef.current = boundaryActive;

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
    if (value.length >= 2) {
      debounceTimer.current = setTimeout(async () => {
        if (autocompleteAbortRef.current) autocompleteAbortRef.current.abort();
        const controller = new AbortController();
        autocompleteAbortRef.current = controller;
        try {
          const result = await autocompleteSearch(value, controller.signal);
          if (result?.suggestions) {
            setSuggestions(result.suggestions);
            setShowSuggestions(result.suggestions.length > 0);
          }
        } catch {
          // AbortError is silently caught by autocompleteSearch
        }
      }, 350);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  };

  const selectSuggestion = (suggestion: string) => {
    setFilters(prev => ({ ...prev, location: suggestion }));
    setShowSuggestions(false);
    setSuggestions([]);
    handleApplyFiltersWithLocation(suggestion);
  };

  const projectSortForBrowse = (sort: SortOption): string => {
    if (sort === 'popular') return 'relevance';
    if (sort === 'newest') return 'date_desc';
    if (sort === 'price_asc') return 'price_asc';
    if (sort === 'price_desc') return 'price_desc';
    return 'relevance';
  };

  const fetchAllProperties = useCallback(async (bounds: LngLatBounds | null, cursorOverride?: { propertyCursor?: any[] | null; projectCursor?: any[] | null; append?: boolean }, polygonOverride?: { lat: number; lng: number }[] | null) => {
    if (isFetchingRef.current) return;
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
    const params: any = { pageSize: isAppend ? 24 : 500, sort: sortByRef.current };

    if (filters.location) params.location = filters.location;
    if (filters.minPrice) params.minPrice = Number(filters.minPrice);
    if (filters.maxPrice) params.maxPrice = Number(filters.maxPrice);
    if (filters.bhkTypeId && bhkIdToLabel[Number(filters.bhkTypeId)]) {
      params.bhkType = bhkIdToLabel[Number(filters.bhkTypeId)];
    }
    if (filters.propertyTypeId && propTypeIdToName[Number(filters.propertyTypeId)]) {
      params.propertyType = propTypeIdToName[Number(filters.propertyTypeId)];
    }

    const activePolygon = polygonOverride ?? (boundaryActive ? boundaryPoints : null);
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
      if (scope === 'both') {
        const combinedParams: any = {
          scope: 'both',
          query: filters.location || undefined,
          minPrice: filters.minPrice ? Number(filters.minPrice) : undefined,
          maxPrice: filters.maxPrice ? Number(filters.maxPrice) : undefined,
          pageSize: isAppend ? 24 : 500,
          sort: sortByRef.current,
        };
        if (filters.bhkTypeId && bhkIdToLabel[Number(filters.bhkTypeId)]) {
          combinedParams.bhkType = bhkIdToLabel[Number(filters.bhkTypeId)];
        }
        if (filters.propertyTypeId && propTypeIdToName[Number(filters.propertyTypeId)]) {
          combinedParams.propertyType = propTypeIdToName[Number(filters.propertyTypeId)];
        }
        if (params.bounds) combinedParams.bounds = params.bounds;
        if (params.polygon) combinedParams.polygon = params.polygon;
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
          if (!isAppend) { setProperties([]); setProjects([]); }
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

          if (isAppend) {
            setProperties(prev => [...prev, ...props]);
            setProjects(prev => [...prev, ...projs]);
            setSortedResultOrder(prev => [...prev, ...order]);
          } else {
            setProperties(props);
            setProjects(projs);
            setSortedResultOrder(order);
          }
          setPropertyTotal(response.propertyTotal ?? 0);
          setProjectTotal(response.projectTotal ?? 0);
          setCombinedNextCursor(response.nextCursor ?? null);
        }
      } else if (scope === 'projects') {
        const projectParams: any = {
          query: filters.location || undefined,
          minPrice: filters.minPrice ? Number(filters.minPrice) : undefined,
          maxPrice: filters.maxPrice ? Number(filters.maxPrice) : undefined,
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
          setProjects(prev => [...prev, ...mapped]);
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
            setProperties(prev => [...prev, ...formattedData]);
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
    }
    if (fetchId === fetchIdRef.current) {
      if (isAppend) setLoadingMore(false);
      else setLoading(false);
    }
  }, [filters, lookupMaps, boundaryActive, boundaryPoints]);

  fetchPropertiesRef.current = fetchAllProperties;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debouncedFetchProperties = useCallback((...args: any[]) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      (fetchPropertiesRef.current as any)(...args);
    }, 1000);
  }, []);

  const highlightMarker = useCallback((id: string | null) => {
    if (mapRef.current) {
      highlightFeature(mapRef.current, id);
    }
  }, []);

  const buildFeatures = useCallback((): ClusterPoint[] => {
    const features: ClusterPoint[] = [];
    for (const p of properties) {
      if (p.latitude != null && p.longitude != null && !isNaN(p.latitude) && !isNaN(p.longitude)) {
        features.push({
          id: p.id,
          type: 'property',
          title: p.title || '',
          price: p.price || 0,
          image: p.images?.[0]?.image_url || '',
          location: p.location_text || '',
          area: p.area ? `${p.area} ${p.area_unit || 'sqft'}` : undefined,
          bedrooms: p.bhk_type_label || undefined,
          bathrooms: p.bathrooms?.toString(),
          latitude: p.latitude,
          longitude: p.longitude,
        });
      }
    }
    for (const p of projects) {
      if (p.latitude != null && p.longitude != null && !isNaN(p.latitude) && !isNaN(p.longitude)) {
        features.push({
          id: p.id,
          type: 'project',
          title: p.name,
          price: p.low_price || 0,
          image: p.primary_image || '',
          location: p.location_name || '',
          latitude: p.latitude,
          longitude: p.longitude,
        });
      }
    }
    return features;
  }, [properties, projects]);

  const fetchClustersAbortRef = useRef<AbortController | null>(null);
  const viewportCacheRef = useRef<Map<string, { data: any; timestamp: number }>>(new Map());

  const getViewportCacheKey = useCallback((
    bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
    zoom: number
  ) => {
    const rounded = {
      minLat: Math.round(bounds.minLat * 100) / 100,
      maxLat: Math.round(bounds.maxLat * 100) / 100,
      minLng: Math.round(bounds.minLng * 100) / 100,
      maxLng: Math.round(bounds.maxLng * 100) / 100,
    };
    return `${rounded.minLat},${rounded.maxLat},${rounded.minLng},${rounded.maxLng}_z${zoom}`;
  }, []);

  const fetchServerClusters = useCallback(async (
    bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
    zoom: number,
    signal?: AbortSignal
  ) => {
    const cacheKey = getViewportCacheKey(bounds, zoom);
    const cached = viewportCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.data;
    }

    try {
      const res = await fetch('/api/clusters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bounds,
          zoom,
          scope: searchScopeRef.current,
          filters: {
            minPrice: filters.minPrice ? Number(filters.minPrice) : undefined,
            maxPrice: filters.maxPrice ? Number(filters.maxPrice) : undefined,
            propertyType: filters.propertyTypeId || undefined,
            bhkType: filters.bhkTypeId || undefined,
          },
        }),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      viewportCacheRef.current.set(cacheKey, { data, timestamp: Date.now() });

      if (viewportCacheRef.current.size > 200) {
        const oldest = viewportCacheRef.current.keys().next().value;
        if (oldest) viewportCacheRef.current.delete(oldest);
      }

      return data;
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      return null;
    }
  }, [filters.minPrice, filters.maxPrice, filters.propertyTypeId, filters.bhkTypeId, getViewportCacheKey]);

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

  const updateClusters = useCallback(() => {
    const map = mapRef.current;
    const clustering = clusteringRef.current;
    if (!map || !clustering) return;

    const bounds = map.getBounds();
    const zoom = map.getZoom();

    if (zoom <= 13) {
      // FAR ZOOM: Server-side clustering via ES geohash_grid
      if (fetchClustersAbortRef.current) fetchClustersAbortRef.current.abort();
      const controller = new AbortController();
      fetchClustersAbortRef.current = controller;

      const bbox = {
        minLat: bounds.getSouth(),
        maxLat: bounds.getNorth(),
        minLng: bounds.getWest(),
        maxLng: bounds.getEast(),
      };

      fetchServerClusters(bbox, zoom, controller.signal).then((data) => {
        if (!data || !mapRef.current) return;

        const merged = mergeOverlappingClusters(data.clusters, 70, mapRef.current);

        const geojson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: merged.map((c: any, i: number) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [c.center_lon || c.lon, c.center_lat || c.lat] },
            properties: {
              point_count: c.count,
              point_count_abbreviated: c.count >= 10000
                ? `${Math.round(c.count / 1000)}k`
                : c.count >= 1000
                  ? `${(c.count / 1000).toFixed(1)}k`
                  : c.count.toString(),
              avg_price: c.avg_price,
              min_price: c.min_price,
              max_price: c.max_price,
              types: c.types,
              _index: i,
            },
          })),
        };

        updateSourceData(mapRef.current, geojson);
        updateCircleRadius(mapRef.current, zoom);
      });
    } else {
      // CLOSE ZOOM: Client-side clustering via supercluster
      const features = buildFeatures();
      clustering.load(features);

      const bbox: [number, number, number, number] = [
        bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
      ];
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
    }
  }, [buildFeatures, fetchServerClusters]);

  useEffect(() => {
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
      const leaves = clusteringRef.current.getLeaves(props.cluster_id, 5);
      const totalCount = props.point_count || 0;
      const leafPoints: ClusterPoint[] = leaves.map((l) => ({
        id: l.properties.id, type: l.properties.type, title: l.properties.title,
        price: l.properties.price || 0, image: l.properties.image || '',
        location: l.properties.location || '',
        latitude: l.geometry.coordinates[1], longitude: l.geometry.coordinates[0],
      }));
      showClusterPreview(map, leafPoints, totalCount, e.lngLat, () => {
        map.flyTo({ center: e.lngLat.toArray() as [number, number], zoom: map.getZoom() + 2, duration: 500 });
      }, props.avg_price, props.min_price, props.max_price);
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

    const onLoad = () => {
      map.addSource('boundary', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': 0 } });
      map.addLayer({ id: 'boundary-outline', type: 'line', source: 'boundary', paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [4, 4], 'line-opacity': 0 } });
      map.addLayer({ id: 'boundary-vertices', type: 'circle', source: 'boundary', filter: ['==', '$type', 'LineString'], paint: { 'circle-radius': 4, 'circle-color': '#2563eb', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      boundarySourceRef.current = map.getSource('boundary') as maplibregl.GeoJSONSource;

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
      const currentZoom = map.getZoom();
      if (currentZoom <= 13) {
        // Far zoom: update server-side clusters
        updateClusters();
      }
      if (searchAsIMoveRef.current) {
        debouncedFetchProperties(map.getBounds());
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
  }, [debouncedFetchProperties, router]);

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
    setFilters(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
  };

  const handleQuickFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, [e.target.name]: e.target.value }));
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
  };

  const handleApplyFiltersWithLocation = async (locationText: string) => {
    if (locationText && process.env.NEXT_PUBLIC_MAPTILER_KEY) {
      setSearchAsIMove(true);
      try {
        const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(locationText)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}&country=IN`);
        const data = await response.json();
        if (data.features && data.features.length > 0) {
          mapRef.current?.flyTo({ center: data.features[0].center, zoom: 13, essential: true });
          return;
        }
      } catch {}
    }
    setPropertyNextCursor(null);
    setProjectNextCursor(null);
    setCombinedNextCursor(null);
    setHasMoreProperties(false);
    setHasMoreProjects(false);
    fetchAllProperties(searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null);
  };

  const handleApplyFilters = async () => {
    handleApplyFiltersWithLocation(filters.location);
  };

  const handleResetFilters = () => {
    setLoading(true);
    setFilters({ location: '', minPrice: '', maxPrice: '', bhkTypeId: '', propertyTypeId: '' });
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
    debounceTimerRef.current = setTimeout(() => {
      fetchPropertiesRef.current(
        searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
      );
    }, 500);
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
    debounceTimerRef.current = setTimeout(() => {
      fetchPropertiesRef.current(
        searchAsIMoveRef.current && mapRef.current ? mapRef.current.getBounds() : null
      );
    }, 500);
  };

  const updateBoundaryLayer = useCallback((points: { lat: number; lng: number }[]) => {
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
    const isClosed = points.length >= 3;
    const geometry = isClosed
      ? { type: 'Polygon' as const, coordinates: [coords] }
      : { type: 'LineString' as const, coordinates: coords };
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] } as any);
    const isActive = boundaryActive && isClosed;
    map.setPaintProperty('boundary-fill', 'fill-opacity', isActive ? 0.15 : 0.12);
    map.setPaintProperty('boundary-outline', 'line-opacity', 0.8);
    map.setPaintProperty('boundary-outline', 'line-width', isActive ? 3 : 2);
    map.setPaintProperty('boundary-outline', 'line-dasharray', isActive ? [1, 0] : [4, 4]);
    map.setPaintProperty('boundary-vertices', 'circle-opacity', 0);
  }, [boundaryActive]);

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
    updateBoundaryLayer(simplified);
    fetchPropertiesRef.current(null, undefined, simplified);
  }, [updateBoundaryLayer]);

  const removeBoundary = useCallback(() => {
    setBoundaryActive(false);
    setBoundaryPoints([]);
    setIsDrawingMode(false);
    drawPointsRef.current = [];
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

  const combinedList = searchScope === 'both'
    ? [
        ...properties.map(p => ({ type: 'property' as const, data: p })),
        ...projects.map(p => ({ type: 'project' as const, data: p })),
      ]
    : searchScope === 'projects'
      ? projects.map(p => ({ type: 'project' as const, data: p }))
      : properties.map(p => ({ type: 'property' as const, data: p }));

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
                        <div key={i} onClick={() => selectSuggestion(s)} className="px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 cursor-pointer transition-colors">
                          {s}
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
                  <select name="propertyTypeId" value={filters.propertyTypeId} onChange={handleFilterChange} className="neumorphic-input w-full text-sm"><option value="">Any Type</option>{propertyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
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
                    const prop = properties.find(p => p.id === entry.id);
                    if (!prop) return null;
                    return (
                      <div key={prop.id} onMouseEnter={() => highlightMarker(prop.id)} onMouseLeave={() => highlightMarker(null)}>
                        <PropertyCard property={prop} />
                      </div>
                    );
                  } else {
                    const proj = projects.find(p => p.id === entry.id);
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
