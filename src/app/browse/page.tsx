'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { LngLatBounds, Marker, Popup } from 'maplibre-gl';
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
  const markersRef = useRef<{ [key: string]: Marker }>({});
  const popupsRef = useRef<{ [key: string]: Popup }>({});
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
  const markerTickRef = useRef(0);

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
  const animInjectedRef = useRef(false);
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
    const params: any = { pageSize: isAppend ? 24 : 100, sort: sortByRef.current };

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
          pageSize: isAppend ? 24 : 48,
          sort: sortByRef.current,
          signal,
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
    }
    if (fetchId === fetchIdRef.current) {
      markerTickRef.current++;
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

  const clearMarkers = useCallback(() => {
    Object.values(markersRef.current).forEach(marker => marker.remove());
    Object.values(popupsRef.current).forEach(popup => popup.remove());
    markersRef.current = {};
    popupsRef.current = {};
  }, []);

  const highlightMarker = useCallback((id: string | null) => {
    Object.entries(markersRef.current).forEach(([key, marker]) => {
      const el = marker.getElement();
      const content = el.firstElementChild as HTMLElement | null;
      if (content) {
        content.style.backgroundColor = content.dataset.defaultColor || '#2563eb';
        content.style.transform = '';
        content.style.animation = '';
      }
      el.style.zIndex = '0';
      if (popupsRef.current[key]) {
        popupsRef.current[key].remove();
      }
    });
    if (id && markersRef.current[id]) {
      const el = markersRef.current[id].getElement();
      const content = el.firstElementChild as HTMLElement | null;
      if (content) {
        content.style.backgroundColor = '#ef4444';
        content.style.transform = 'scale(1.3)';
        content.style.transformOrigin = 'bottom';
        content.style.animation = 'marker-pulse 1.5s ease-in-out infinite';
      }
      el.style.zIndex = '10';
      const lngLat = markersRef.current[id].getLngLat();
      popupsRef.current[id].setLngLat(lngLat).addTo(mapRef.current!);
    }
  }, []);

  const updateMarkers = useCallback((props: PropertyBrowse[], projs: ProjectBrowse[]) => {
    if (!mapRef.current) return;

    const newPropertyIds = new Set(props.map(p => p.id));
    const newProjectKeys = new Set(projs.map(p => `proj_${p.id}`));
    const allValidKeys = new Set([...newPropertyIds, ...newProjectKeys]);
    Object.keys(markersRef.current).forEach(id => {
      if (!allValidKeys.has(id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
        if (popupsRef.current[id]) {
          popupsRef.current[id].remove();
          delete popupsRef.current[id];
        }
      }
    });

    const isValidCoord = (v: any): boolean => v != null && typeof v === 'number' && !isNaN(v);

    props.forEach(prop => {
      if (isValidCoord(prop.latitude) && isValidCoord(prop.longitude) && !markersRef.current[prop.id]) {
        const markerEl = document.createElement('div');
        markerEl.className = 'px-2 py-1 text-white text-xs font-bold border-2 border-white rounded-full cursor-pointer shadow-lg transition-all duration-200';
        markerEl.style.backgroundColor = '#2563eb';
        markerEl.dataset.defaultColor = '#2563eb';
        markerEl.textContent = `₹${((prop.price || 0) / 100000).toFixed(0)}L`;

        const popupDiv = document.createElement('div');
        popupDiv.className = 'p-1';
        const titleDiv = document.createElement('div');
        titleDiv.className = 'font-bold text-sm text-text-color-dark';
        titleDiv.textContent = prop.title || '';
        const priceDiv = document.createElement('div');
        priceDiv.className = 'text-xs text-text-color-light';
        priceDiv.textContent = `₹${(prop.price || 0).toLocaleString()}`;
        popupDiv.appendChild(titleDiv);
        popupDiv.appendChild(priceDiv);
        const popup = new Popup({ offset: 25, closeButton: false, className: 'neumorphic-popup' }).setDOMContent(popupDiv);

        const marker = new Marker({ element: markerEl, anchor: 'bottom' })
          .setLngLat([prop.longitude, prop.latitude])
          .addTo(mapRef.current!);

        marker.getElement().addEventListener('click', () => router.push(`/property/${prop.id}`));
        marker.getElement().addEventListener('mouseenter', () => popup.setLngLat([prop.longitude!, prop.latitude!]).addTo(mapRef.current!));
        marker.getElement().addEventListener('mouseleave', () => popup.remove());
        markersRef.current[prop.id] = marker;
        popupsRef.current[prop.id] = popup;
      }
    });

    projs.forEach(proj => {
      if (isValidCoord(proj.latitude) && isValidCoord(proj.longitude) && !markersRef.current[`proj_${proj.id}`]) {
        const markerEl = document.createElement('div');
        markerEl.className = 'px-2 py-1 text-white text-xs font-bold border-2 border-white rounded-full cursor-pointer shadow-lg transition-all duration-200';
        markerEl.style.backgroundColor = PROJECT_MARKER_COLOR;
        markerEl.dataset.defaultColor = PROJECT_MARKER_COLOR;
        markerEl.textContent = `${((proj.low_price || 0) / 100000).toFixed(0)}L`;

        const popupDiv = document.createElement('div');
        popupDiv.className = 'p-1';
        const titleDiv = document.createElement('div');
        titleDiv.className = 'font-bold text-sm text-text-color-dark';
        titleDiv.textContent = proj.name;
        const priceDiv = document.createElement('div');
        priceDiv.className = 'text-xs text-text-color-light';
        priceDiv.textContent = `${(proj.low_price || 0).toLocaleString()} - ${(proj.high_price || 0).toLocaleString()}`;
        popupDiv.appendChild(titleDiv);
        popupDiv.appendChild(priceDiv);
        const popup = new Popup({ offset: 25, closeButton: false, className: 'neumorphic-popup' }).setDOMContent(popupDiv);

        const marker = new Marker({ element: markerEl, anchor: 'bottom' })
          .setLngLat([proj.longitude, proj.latitude])
          .addTo(mapRef.current!);

        marker.getElement().addEventListener('click', () => router.push(`/projects/${proj.id}`));
        marker.getElement().addEventListener('mouseenter', () => popup.setLngLat([proj.longitude!, proj.latitude!]).addTo(mapRef.current!));
        marker.getElement().addEventListener('mouseleave', () => popup.remove());
        markersRef.current[`proj_${proj.id}`] = marker;
        popupsRef.current[`proj_${proj.id}`] = popup;
      }
    });
  }, [router]);

  useEffect(() => {
    updateMarkers(properties, projects);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerTickRef.current, properties, projects, updateMarkers]);

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

    const onLoad = () => {
      map.addSource('boundary', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'boundary-fill', type: 'fill', source: 'boundary', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': 0 } });
      map.addLayer({ id: 'boundary-outline', type: 'line', source: 'boundary', paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [4, 4], 'line-opacity': 0 } });
      map.addLayer({ id: 'boundary-vertices', type: 'circle', source: 'boundary', filter: ['==', '$type', 'LineString'], paint: { 'circle-radius': 4, 'circle-color': '#2563eb', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      boundarySourceRef.current = map.getSource('boundary') as maplibregl.GeoJSONSource;
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
      clearMarkers();
      map.remove();
      mapRef.current = null;
    };
  }, [clearMarkers, debouncedFetchProperties]);

  useEffect(() => {
    if (!animInjectedRef.current) {
      const style = document.createElement('style');
      style.textContent = `
        @keyframes marker-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
          50% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
        }
      `;
      document.head.appendChild(style);
      animInjectedRef.current = true;
    }
  }, []);

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
    clearMarkers();
    if (mapRef.current) {
      mapRef.current.dragPan.disable();
      mapRef.current.scrollZoom.disable();
      mapRef.current.boxZoom.disable();
      mapRef.current.doubleClickZoom.disable();
      mapRef.current.getCanvas().style.cursor = 'crosshair';
    }
  }, [clearMarkers]);

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
