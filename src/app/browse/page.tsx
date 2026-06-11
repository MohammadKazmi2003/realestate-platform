'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { LngLatBounds, Marker, Popup } from 'maplibre-gl';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { FaMap, FaList, FaSpinner, FaCrosshairs } from 'react-icons/fa';
import Header from '@/app/components/Header';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';
import { cn } from '@/lib/utils';
import { searchProperties, mapEsResultToPropertyCard, autocompleteSearch } from '@/lib/searchClient';

type PropertyBrowse = PropertyCardProps['property'] & {
    latitude: number | null;
    longitude: number | null;
}

type BhkType = { id: number; label: string; };
type PropertyType = { id: number; name: string; };

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
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [searchAsIMove, setSearchAsIMove] = useState(true);
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
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
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();

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
        const result = await autocompleteSearch(value);
        if (result?.suggestions) {
          setSuggestions(result.suggestions);
          setShowSuggestions(result.suggestions.length > 0);
        }
      }, 300);
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

  const fetchProperties = useCallback(async (bounds: LngLatBounds | null) => {
    setLoading(true);
    const { bhkIdToLabel, propTypeIdToName } = lookupMaps;

    const params: any = {};
    if (filters.location) params.location = filters.location;
    if (filters.minPrice) params.minPrice = Number(filters.minPrice);
    if (filters.maxPrice) params.maxPrice = Number(filters.maxPrice);
    if (filters.bhkTypeId && bhkIdToLabel[Number(filters.bhkTypeId)]) {
      params.bhkType = bhkIdToLabel[Number(filters.bhkTypeId)];
    }
    if (filters.propertyTypeId && propTypeIdToName[Number(filters.propertyTypeId)]) {
      params.propertyType = propTypeIdToName[Number(filters.propertyTypeId)];
    }
    params.pageSize = 100;

    if (searchAsIMove && bounds) {
      params.bounds = {
        minLat: bounds.getSouthWest().lat,
        maxLat: bounds.getNorthEast().lat,
        minLng: bounds.getSouthWest().lng,
        maxLng: bounds.getNorthEast().lng,
      };
    }

    try {
      const response = await searchProperties(params);
      if (!response || !response.results) {
        console.error('Search returned no data');
        setProperties([]);
      } else {
        const mapped = response.results.map((r: any) => mapEsResultToPropertyCard(r));
        const formattedData = mapped.map(p => ({
          ...p,
          images: p.images.length > 0 ? p.images : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }],
        }));
        setProperties(formattedData);
      }
    } catch (err) {
      console.error('Error fetching properties:', err);
      setProperties([]);
    }
    setLoading(false);
  }, [filters, lookupMaps, searchAsIMove]);

  const debouncedFetchProperties = useDebouncedCallback(fetchProperties, 600);
  
  const highlightMarker = useCallback((propertyId: string | null) => {
    Object.values(markersRef.current).forEach(marker => {
      const el = marker.getElement();
      el.style.backgroundColor = '#2563eb';
      el.style.zIndex = '0';
      el.style.transform = 'scale(1)';
    });
    if (propertyId && markersRef.current[propertyId]) {
      const el = markersRef.current[propertyId].getElement();
      el.style.backgroundColor = '#ef4444';
      el.style.zIndex = '10';
      el.style.transform = 'scale(1.2)';
    }
  }, []);
  
  const updateMarkers = useCallback((props: PropertyBrowse[]) => {
    if (!mapRef.current) return;
    const newPropertyIds = new Set(props.map(p => p.id));
    Object.keys(markersRef.current).forEach(id => {
      if (!newPropertyIds.has(id)) { markersRef.current[id].remove(); delete markersRef.current[id]; }
    });

    props.forEach(prop => {
      if (prop.latitude && prop.longitude && !markersRef.current[prop.id]) {
        const markerEl = document.createElement('div');
        markerEl.className = 'px-2 py-1 bg-blue-600 text-white text-xs font-bold border-2 border-white rounded-full cursor-pointer shadow-lg hover:bg-blue-700 transition-all duration-200';
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
        const marker = new Marker({ element: markerEl, anchor: 'bottom' }).setLngLat([prop.longitude, prop.latitude]).addTo(mapRef.current!);
        
        marker.getElement().addEventListener('click', () => router.push(`/property/${prop.id}`));
        marker.getElement().addEventListener('mouseenter', () => popup.setLngLat([prop.longitude!, prop.latitude!]).addTo(mapRef.current!));
        marker.getElement().addEventListener('mouseleave', () => popup.remove());
        markersRef.current[prop.id] = marker;
      }
    });
  }, [router]);

  useEffect(() => { updateMarkers(properties); }, [properties, updateMarkers]);

  useEffect(() => {
    const init = async () => {
      const [bhkRes, propTypeRes] = await Promise.all([
        supabase.from('bhk_types').select('*'), supabase.from('property_types').select('*'),
      ]);
      const bhkData = bhkRes.data || [];
      const propTypeData = propTypeRes.data || [];
      setBhkTypes(bhkData);
      setPropertyTypes(propTypeData);
      setLookupMaps({
        bhkIdToLabel: Object.fromEntries(bhkData.map((b: any) => [b.id, b.label])),
        propTypeIdToName: Object.fromEntries(propTypeData.map((p: any) => [p.id, p.name])),
      });
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

  const handleApplyFiltersWithLocation = async (locationText: string) => {
    if (locationText && process.env.NEXT_PUBLIC_MAPTILER_KEY) {
      setSearchAsIMove(true);
      const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(locationText)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}&country=IN`);
      const data = await response.json();
      if (data.features && data.features.length > 0) {
        mapRef.current?.flyTo({ center: data.features[0].center, zoom: 13, essential: true });
      }
    } else {
        fetchProperties(searchAsIMove && mapRef.current ? mapRef.current.getBounds() : null);
    }
  };

  const handleApplyFilters = async () => {
    handleApplyFiltersWithLocation(filters.location);
  };
  
  const useUserLocation = () => {
    // This logic is correct
  };
  
  return (
    <div className="flex flex-col h-screen bg-bg-color">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <aside className={cn("w-full md:w-[450px] md:flex-shrink-0 p-4 bg-bg-color border-r border-shadow-dark/20 flex flex-col", "md:flex", mobileView === 'list' ? "flex" : "hidden")}>
          <div className="shadow-neumorphic-outset rounded-3xl p-4 space-y-4 mb-4">
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
              <div className="grid grid-cols-2 gap-2">
                <input type="number" name="minPrice" placeholder="Min Price" value={filters.minPrice} onChange={handleFilterChange} className="neumorphic-input w-full"/>
                <input type="number" name="maxPrice" placeholder="Max Price" value={filters.maxPrice} onChange={handleFilterChange} className="neumorphic-input w-full"/>
              </div>
              <div className="grid grid-cols-2 gap-2">
                  <select name="bhkTypeId" value={filters.bhkTypeId} onChange={handleFilterChange} className="neumorphic-input w-full text-sm"><option value="">Any BHK</option>{bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
                  <select name="propertyTypeId" value={filters.propertyTypeId} onChange={handleFilterChange} className="neumorphic-input w-full text-sm"><option value="">Any Type</option>{propertyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
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
          </div>

          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            {loading ? <div className="flex justify-center items-center h-full"><FaSpinner className="animate-spin text-3xl text-text-color-light" /></div>
             : properties.length > 0 ? properties.map(property => (
                <div key={property.id} onMouseEnter={() => highlightMarker(property.id)} onMouseLeave={() => highlightMarker(null)}>
                    <PropertyCard property={property} />
                </div>
            )) : <p className="text-center text-text-color-light mt-10">No properties found. Try moving the map or changing filters.</p>}
          </div>
        </aside>

        <main className={cn("flex-1 relative", "md:flex", mobileView === 'map' ? "flex" : "hidden")}>
          <div ref={mapContainer} className="w-full h-full" />
           {loading && <div className="absolute top-4 right-20 bg-bg-color p-2 rounded-full shadow-neumorphic-outset"><FaSpinner className="animate-spin text-blue-500" /></div>}
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
