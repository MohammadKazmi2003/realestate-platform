'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { LngLatBounds, Marker, Popup } from 'maplibre-gl';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { FaMap, FaList, FaSpinner, FaCrosshairs } from 'react-icons/fa';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import Header from '@/app/components/Header';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';
import { ProjectCard } from '@/app/components/ProjectCard';
import { cn } from '@/lib/utils';
import type { Project } from '@/lib/types';

type PropertyBrowse = PropertyCardProps['property'] & {
    latitude: number | null;
    longitude: number | null;
}

type ProjectBrowse = Project & {
  latitude: number | null;
  longitude: number | null;
};

type SearchScope = 'properties' | 'projects' | 'both';

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; parent_id: number | null };

// Systematic BHK options — no more 1.5/2.5 inconsistencies.
// Filtering is client-side on `bedrooms` so it works with any bhk_types data.
const BHK_OPTIONS = [
  { value: '', label: 'Any BHK' },
  { value: 'studio', label: 'Studio' },
  { value: '1+', label: '1+' },
  { value: '2+', label: '2+' },
  { value: '3+', label: '3+' },
  { value: '4+', label: '4+' },
  { value: '5+', label: '5+' },
  { value: '6+', label: '6+' },
];

function bedroomsFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const t = label.trim().toLowerCase();
  if (t.startsWith('studio') || t.startsWith('1 rk')) return 0;
  const m = t.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  return Math.floor(parseFloat(m[1]));
}

function matchesBhkFilter(bhkLabel: string | null | undefined, bedrooms: number | null | undefined, filter: string): boolean {
  if (!filter) return true;
  const b = typeof bedrooms === 'number' && Number.isFinite(bedrooms) ? bedrooms : bedroomsFromLabel(bhkLabel);
  if (filter === 'studio') return b === 0;
  const min = parseInt(filter.replace('+', ''), 10);
  if (!Number.isFinite(min)) return true;
  return b != null && b >= min;
}

const DEFAULT_CENTER: [number, number] = [77.0266, 28.4595];
const DEFAULT_ZOOM = 11;

const useDebouncedCallback = (callback: (...args: any[]) => void, delay: number) => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  return useCallback((...args: any[]) => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => callback(...args), delay);
  }, [callback, delay]);
};

export default function BrowsePage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<{ [key: string]: Marker }>({});
  const router = useRouter();

  const [properties, setProperties] = useState<PropertyBrowse[]>([]);
  const [projects, setProjects] = useState<ProjectBrowse[]>([]);
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [searchAsIMove, setSearchAsIMove] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ location: '', minPrice: '', maxPrice: '', bhkMin: '', propertyTypeId: '' });
  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);
  // Collapse/expand for fixed filters so they don't permanently consume space
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  // Projects / Properties scope
  const [scope, setScope] = useState<SearchScope>('both');
  // Clicked listing (marker or card) — shows detail card overlay like new-admin
  const [selected, setSelected] = useState<{ kind: 'property' | 'project'; id: string } | null>(null);

  const groupedPropertyTypes = useMemo(() => {
    // Systematic hierarchy: Residential → Apartment/Villa, Commercial → Office/Retail, Land.
    // Hide bare parent placeholders (Residential/Commercial) as selectable options.
    const byId = new Map(propertyTypes.map(p => [p.id, p]));
    const groups: { label: string; options: PropertyType[] }[] = [];
    const residential = propertyTypes.filter(p => p.parent_id === 1);
    const commercial = propertyTypes.filter(p => p.parent_id === 2);
    const land = propertyTypes.filter(p => p.id === 3 || (p.parent_id == null && !byId.has(p.id) && /land|plot/i.test(p.name)));
    // Fallback: if parent_id missing, group by name heuristics
    if (residential.length === 0 && commercial.length === 0) {
      const res: PropertyType[] = [];
      const com: PropertyType[] = [];
      const other: PropertyType[] = [];
      for (const p of propertyTypes) {
        const n = p.name.toLowerCase();
        if (/apartment|villa|house|residential/.test(n) && p.name !== 'Residential' && p.name !== 'Commercial') res.push(p);
        else if (/commercial|office|retail|shop/.test(n) && p.name !== 'Residential' && p.name !== 'Commercial') com.push(p);
        else if (/land|plot/.test(n)) other.push(p);
      }
      if (res.length) groups.push({ label: 'Residential', options: res });
      if (com.length) groups.push({ label: 'Commercial', options: com });
      if (other.length) groups.push({ label: 'Land', options: other });
      if (groups.length === 0) groups.push({ label: 'All types', options: propertyTypes });
      return groups;
    }
    if (residential.length) groups.push({ label: 'Residential', options: residential });
    if (commercial.length) groups.push({ label: 'Commercial', options: commercial });
    const landOpts = propertyTypes.filter(p => p.id === 3);
    if (landOpts.length) groups.push({ label: 'Land', options: landOpts });
    else if (land.length) groups.push({ label: 'Land', options: land });
    return groups;
  }, [propertyTypes]);

  const fetchProperties = useCallback(async (bounds: LngLatBounds | null, scopeOverride?: SearchScope, filtersOverride?: typeof filters) => {
    setLoading(true);
    const activeFilters = filtersOverride ?? filters;
    const activeScope = scopeOverride ?? scope;
    let boundParams: any = {};
    if (searchAsIMove && bounds) {
      const { _ne, _sw } = bounds as any;
      if (_ne && _sw) boundParams = { min_lat: _sw.lat, max_lat: _ne.lat, min_lng: _sw.lng, max_lng: _ne.lng };
    }
    try {
      if (activeScope === 'properties' || activeScope === 'both') {
        const params: any = {
          p_location_text: activeFilters.location || null,
          p_min_price: activeFilters.minPrice ? Number(activeFilters.minPrice) : null,
          p_max_price: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : null,
          p_bhk_type_id: null, // systematic BHK filtering is client-side (see matchesBhkFilter)
          p_property_type_id: activeFilters.propertyTypeId ? Number(activeFilters.propertyTypeId) : null,
          ...boundParams,
        };
        const { data, error } = await supabase.rpc('search_properties', params);
        if (error) {
          console.error('Error fetching properties:', error);
          setProperties([]);
        } else {
          const formatted = ((data || []) as any[])
            .filter(p => matchesBhkFilter(p.bhk_type_label, p.bedrooms, activeFilters.bhkMin))
            .map(p => ({
              ...p,
              images: p.image_url ? [{ image_url: p.image_url }] : [],
            }));
          setProperties(formatted);
        }
      } else {
        setProperties([]);
      }

      if (activeScope === 'projects' || activeScope === 'both') {
        const { data, error } = await supabase.rpc('search_projects', {
          p_page_num: 1,
          p_items_per_page: 100,
          p_sort_by: 'created_at_desc',
          p_search_text: activeFilters.location || null,
          p_completion_status: null,
          p_bedrooms: null,
          p_min_price: activeFilters.minPrice ? Number(activeFilters.minPrice) : null,
          p_max_price: activeFilters.maxPrice ? Number(activeFilters.maxPrice) : null,
          p_amenity_ids: null,
        });
        if (error) {
          console.error('Error fetching projects:', error);
          setProjects([]);
        } else {
          // Enrich with lat/lng for map markers (basic version: direct table lookup)
          const rows = (data || []) as any[];
          const enriched: ProjectBrowse[] = await Promise.all(rows.slice(0, 100).map(async (r: any) => {
            let lat: number | null = null;
            let lng: number | null = null;
            try {
              const { data: prow } = await supabase.from('projects').select('latitude,longitude').eq('id', r.id).maybeSingle();
              lat = (prow as any)?.latitude != null ? Number((prow as any).latitude) : null;
              lng = (prow as any)?.longitude != null ? Number((prow as any).longitude) : null;
            } catch {}
            return { ...r, latitude: lat, longitude: lng };
          }));
          // Bounds + BHK client filtering for projects (bedrooms via unit_configurations is RPC-filtered only when exact; here keep bounds only)
          let filtered = enriched;
          if (searchAsIMove && bounds) {
            const { _ne, _sw } = bounds as any;
            if (_ne && _sw) filtered = filtered.filter(p => p.latitude != null && p.longitude != null && p.latitude >= _sw.lat && p.latitude <= _ne.lat && p.longitude >= _sw.lng && p.longitude <= _ne.lng);
          }
          setProjects(filtered);
        }
      } else {
        setProjects([]);
      }
    } finally {
      setLoading(false);
    }
  }, [filters, scope, searchAsIMove]);

  const debouncedFetchProperties = useDebouncedCallback(fetchProperties, 600);

  const highlightMarker = useCallback((propertyId: string | null) => {
    // FIX: never touch el.style.transform (MapLibre uses it for positioning —
    // overwriting it sent all markers to top-left). Only toggle visual bubble.
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      const el = marker.getElement() as HTMLElement;
      const bubble = el.querySelector('[data-bubble]') as HTMLElement | null;
      const target = bubble || el;
      if (id === propertyId) {
        target.style.backgroundColor = '#ef4444';
        target.style.zIndex = '10';
        if (bubble) bubble.style.transform = 'scale(1.15)';
        el.style.zIndex = '10';
      } else {
        const isProject = id.startsWith('project:');
        target.style.backgroundColor = isProject ? '#7c3aed' : '#2563eb';
        target.style.zIndex = '0';
        if (bubble) bubble.style.transform = 'scale(1)';
        el.style.zIndex = '0';
      }
    });
  }, []);

  const selectedProperty = useMemo(() => properties.find(p => p.id === selected?.id && selected?.kind === 'property') || null, [properties, selected]);
  const selectedProject = useMemo(() => projects.find(p => p.id === selected?.id && selected?.kind === 'project') || null, [projects, selected]);

  const updateMarkers = useCallback((props: PropertyBrowse[], projs: ProjectBrowse[]) => {
    if (!mapRef.current) return;
    const newIds = new Set([...props.map(p => `prop:${p.id}`), ...projs.map(p => `project:${p.id}`)]);
    Object.keys(markersRef.current).forEach(id => {
      if (!newIds.has(id)) { markersRef.current[id].remove(); delete markersRef.current[id]; }
    });

    const upsert = (key: string, lat: number, lng: number, label: string, title: string, price: number | null, kind: 'property' | 'project', id: string, bg: string) => {
      if (markersRef.current[key]) return;
      const markerEl = document.createElement('div');
      // Outer is positioned by MapLibre — do NOT scale/transform it.
      markerEl.style.background = 'transparent';
      const bubble = document.createElement('div');
      bubble.setAttribute('data-bubble', '1');
      bubble.className = 'px-2 py-1 text-white text-xs font-bold border-2 border-white rounded-full cursor-pointer shadow-lg transition-all duration-200';
      bubble.style.backgroundColor = bg;
      bubble.style.display = 'inline-block';
      bubble.textContent = label;
      markerEl.appendChild(bubble);

      const popup = new Popup({ offset: 25, closeButton: false, className: 'neumorphic-popup' }).setHTML(`<div class="p-1"><div class="font-bold text-sm text-text-color-dark">${title}</div><div class="text-xs text-text-color-light">${price ? `₹${Number(price).toLocaleString()}` : 'Price on request'}</div><div class="text-[11px] text-text-color-light">${kind === 'project' ? 'Project — click to view' : 'Property — click to view'}</div></div>`);
      const marker = new Marker({ element: markerEl, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(mapRef.current!);

      // Hover: non-interactive preview only (never steals clicks)
      markerEl.addEventListener('mouseenter', () => {
        highlightMarker(key);
        popup.setLngLat([lng, lat]).addTo(mapRef.current!);
      });
      markerEl.addEventListener('mouseleave', () => {
        highlightMarker(null);
        popup.remove();
      });
      // Click: show fixed detail card overlay (like new-admin), not immediate nav
      markerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelected({ kind, id });
      });
      markersRef.current[key] = marker;
    };

    props.forEach(prop => {
      if (prop.latitude && prop.longitude) {
        upsert(`prop:${prop.id}`, prop.latitude, prop.longitude, `₹${((prop.price || 0) / 100000).toFixed(0)}L`, prop.title || 'Property', prop.price, 'property', prop.id, '#2563eb');
      }
    });
    projs.forEach(proj => {
      const lat = (proj as any).latitude;
      const lng = (proj as any).longitude;
      if (lat != null && lng != null) {
        const price = (proj as any).low_price || 0;
        upsert(`project:${proj.id}`, Number(lat), Number(lng), price ? `₹${(Number(price) / 100000).toFixed(0)}L` : 'Project', (proj as any).name || 'Project', price, 'project', proj.id, '#7c3aed');
      }
    });
  }, [highlightMarker]);

  useEffect(() => { updateMarkers(properties, projects); }, [properties, projects, updateMarkers]);

  useEffect(() => {
    const init = async () => {
      const [bhkRes, propTypeRes] = await Promise.all([
        supabase.from('bhk_types').select('*'), supabase.from('property_types').select('*'),
      ]);
      setBhkTypes(bhkRes.data || []);
      setPropertyTypes((propTypeRes.data || []) as PropertyType[]);
    };
    init();

    if (mapRef.current || !mapContainer.current || !process.env.NEXT_PUBLIC_MAPTILER_KEY) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current!,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`,
      center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM,
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    const onMapInteraction = () => {
      if (mapRef.current && searchAsIMove) {
          debouncedFetchProperties(mapRef.current.getBounds());
      }
    };
    mapRef.current.on('load', () => fetchProperties(mapRef.current!.getBounds()));
    mapRef.current.on('moveend', onMapInteraction);

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [debouncedFetchProperties, fetchProperties, searchAsIMove]);

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleApplyFilters = async () => {
    if (filters.location && process.env.NEXT_PUBLIC_MAPTILER_KEY) {
      setSearchAsIMove(true);
      const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(filters.location)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}&country=IN`);
      const data = await response.json();
      if (data.features && data.features.length > 0) {
        mapRef.current?.flyTo({ center: data.features[0].center, zoom: 13, essential: true });
      }
    } else {
        fetchProperties(searchAsIMove && mapRef.current ? mapRef.current.getBounds() : null);
    }
  };

  const useUserLocation = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation not supported.');
      return;
    }
    setIsLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const center: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        mapRef.current?.flyTo({ center, zoom: 13, essential: true });
        setIsLocating(false);
      },
      (err) => {
        setLocationError(err.message);
        setIsLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  };

  const activeFilterCount = (filters.bhkMin ? 1 : 0) + (filters.propertyTypeId ? 1 : 0) + (filters.minPrice ? 1 : 0) + (filters.maxPrice ? 1 : 0) + (filters.location ? 1 : 0);

  return (
    <div className="flex flex-col h-screen bg-bg-color">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <aside className={cn("w-full md:w-[450px] md:flex-shrink-0 p-4 bg-bg-color border-r border-shadow-dark/20 flex flex-col", "md:flex", mobileView === 'list' ? "flex" : "hidden")}>
          <div className="shadow-neumorphic-outset rounded-3xl p-4 space-y-4 mb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-text-color-dark">Filters</h2>
                  {activeFilterCount > 0 && <span className="text-xs bg-blue-600 text-white rounded-full px-2 py-0.5">{activeFilterCount}</span>}
                </div>
                <button onClick={() => setFiltersCollapsed(v => !v)} className="neumorphic-button !p-2 !rounded-full" title={filtersCollapsed ? 'Expand filters' : 'Collapse filters'}>
                  {filtersCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                </button>
              </div>

              {/* Projects / Properties scope */}
              <div className="grid grid-cols-3 gap-1 p-1 rounded-2xl shadow-neumorphic-inset">
                {(['properties', 'projects', 'both'] as SearchScope[]).map(s => (
                  <button key={s} onClick={() => { setScope(s); fetchProperties(mapRef.current?.getBounds() || null, s); }} className={cn("text-xs font-semibold px-2 py-2 rounded-xl transition", scope === s ? "shadow-neumorphic-outset bg-bg-color text-text-color-dark" : "text-text-color-light")}>
                    {s === 'both' ? 'Both' : s === 'properties' ? 'Properties' : 'Projects'}
                  </button>
                ))}
              </div>

              {!filtersCollapsed && (
              <>
              <input type="text" name="location" placeholder="Search by location..." value={filters.location} onChange={handleFilterChange} className="neumorphic-input w-full"/>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" name="minPrice" placeholder="Min Price" value={filters.minPrice} onChange={handleFilterChange} className="neumorphic-input w-full"/>
                <input type="number" name="maxPrice" placeholder="Max Price" value={filters.maxPrice} onChange={handleFilterChange} className="neumorphic-input w-full"/>
              </div>
              <div className="grid grid-cols-2 gap-2">
                  <select name="bhkMin" value={filters.bhkMin} onChange={handleFilterChange} className="neumorphic-input w-full text-sm">
                    {BHK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <select name="propertyTypeId" value={filters.propertyTypeId} onChange={handleFilterChange} className="neumorphic-input w-full text-sm">
                    <option value="">Any Type</option>
                    {groupedPropertyTypes.map(g => (
                      <optgroup key={g.label} label={g.label}>
                        {g.options.map(p => <option key={p.id} value={p.id}>{p.name.replace(/^Residential\s+|^Commercial\s+/i, '')}</option>)}
                      </optgroup>
                    ))}
                  </select>
              </div>
              <div className="flex items-center justify-between p-2 rounded-2xl">
                <label htmlFor="search-as-i-move" className="text-sm font-medium text-text-color-dark">Search as I move</label>
                <input id="search-as-i-move" type="checkbox" checked={searchAsIMove} onChange={() => setSearchAsIMove(!searchAsIMove)} className="h-4 w-4 rounded shadow-neumorphic-inset appearance-none checked:bg-success-color transition"/>
              </div>
              <button onClick={handleApplyFilters} className="neumorphic-button bg-cta-gradient w-full">Apply Filters</button>
              <div>
                <button onClick={useUserLocation} disabled={isLocating} className="neumorphic-button w-full flex items-center justify-center gap-2">
                    {isLocating ? <FaSpinner className="animate-spin"/> : <FaCrosshairs/>} {isLocating ? 'Locating...' : 'Use My Location'}
                </button>
                {locationError && <p className="text-xs text-danger-color mt-1 text-center">{locationError}</p>}
              </div>
              </>
              )}
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            {loading ? <div className="flex justify-center items-center h-full"><FaSpinner className="animate-spin text-3xl text-text-color-light" /></div>
              : (
              <>
                {(scope === 'properties' || scope === 'both') && properties.map(property => (
                 <div key={`prop-${property.id}`} onMouseEnter={() => highlightMarker(`prop:${property.id}`)} onMouseLeave={() => highlightMarker(null)} onClick={() => setSelected({ kind: 'property', id: property.id })} className="cursor-pointer">
                     <PropertyCard property={property} />
                 </div>
                ))}
                {(scope === 'projects' || scope === 'both') && projects.map(project => (
                 <div key={`proj-${project.id}`} onMouseEnter={() => highlightMarker(`project:${project.id}`)} onMouseLeave={() => highlightMarker(null)} onClick={() => setSelected({ kind: 'project', id: project.id })} className="cursor-pointer">
                     <ProjectCard project={project} />
                 </div>
                ))}
                {properties.length === 0 && projects.length === 0 && <p className="text-center text-text-color-light mt-10">No properties found. Try moving the map or changing filters.</p>}
              </>
              )}
          </div>
        </aside>

        <main className={cn("flex-1 relative", "md:flex", mobileView === 'map' ? "flex" : "hidden")}>
          <div ref={mapContainer} className="w-full h-full" />
           {loading && <div className="absolute top-4 right-20 bg-bg-color p-2 rounded-full shadow-neumorphic-outset"><FaSpinner className="animate-spin text-blue-500" /></div>}
           {selected && (
             <div className="absolute left-4 bottom-4 z-10 w-[320px] max-w-[85vw]">
               <div className="relative shadow-neumorphic-outset rounded-3xl bg-bg-color p-2">
                 <button onClick={() => setSelected(null)} className="absolute -top-2 -right-2 z-10 bg-bg-color shadow-neumorphic-outset rounded-full p-1.5" title="Close">
                   <X size={14} />
                 </button>
                 {selected.kind === 'property' && selectedProperty ? (
                   <div onClick={() => router.push(`/property/${selectedProperty.id}`)} className="cursor-pointer">
                     <PropertyCard property={selectedProperty} />
                   </div>
                 ) : selected.kind === 'project' && selectedProject ? (
                   <ProjectCard project={selectedProject} />
                 ) : (
                   <div className="p-4 text-sm text-text-color-light">Loading…</div>
                 )}
               </div>
             </div>
           )}
        </main>
      </div>

       <div className="md:hidden fixed bottom-6 right-6 z-20">
            <button onClick={() => setMobileView(v => v === 'list' ? 'map' : 'list')} className="neumorphic-button flex items-center justify-center gap-2 bg-cta-gradient py-3 px-4 rounded-full">
                {mobileView === 'list' ? <FaMap/> : <FaList/>}
                <span>{mobileView === 'list' ? 'Map' : 'List'}</span>
            </button>
        </div>
    </div>
  );
}
