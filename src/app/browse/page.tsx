// src/app/browse/page.tsx
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { LngLatBounds, Marker, Popup } from 'maplibre-gl';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import { FaMap, FaList, FaSpinner, FaMapMarkerAlt, FaCrosshairs } from 'react-icons/fa';
import Header from '@/app/components/Header';
import Link from 'next/link';
import { cn } from '@/lib/utils';

// --- Type Definitions ---
type Property = {
  id: string; title: string | null; price?: number | null; location_text: string | null;
  bhk_type: string | null; area_sqft: number | null; latitude: number | null; longitude: number | null;
  user_id?: string; image_url: string | null;
};
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

// --- Main Component ---
export default function BrowsePage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<{ [key: string]: Marker }>({});
  const router = useRouter();

  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [searchAsIMove, setSearchAsIMove] = useState(true);
  
  // --- New states for geolocation feedback ---
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const [filters, setFilters] = useState({ location: '', minPrice: '', maxPrice: '', bhkTypeId: '', propertyTypeId: '' });
  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);

  const fetchProperties = useCallback(async (bounds: LngLatBounds | null) => {
    setLoading(true);
    let params: any = {
      p_location_text: filters.location || null,
      p_min_price: filters.minPrice ? Number(filters.minPrice) : null,
      p_max_price: filters.maxPrice ? Number(filters.maxPrice) : null,
      p_bhk_type_id: filters.bhkTypeId ? Number(filters.bhkTypeId) : null,
      p_property_type_id: filters.propertyTypeId ? Number(filters.propertyTypeId) : null,
    };
    
    if (searchAsIMove && bounds) {
      const { _ne, _sw } = bounds;
      params = { ...params, min_lat: _sw.lat, max_lat: _ne.lat, min_lng: _sw.lng, max_lng: _ne.lng };
    }
    
    const { data, error } = await supabase.rpc('search_properties', params);
    if (error) console.error('Error fetching properties:', error);
    else setProperties(data || []);
    setLoading(false);
  }, [filters, searchAsIMove]);

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
  
  const updateMarkers = useCallback((props: Property[]) => {
    if (!mapRef.current) return;
    const newPropertyIds = new Set(props.map(p => p.id));
    Object.keys(markersRef.current).forEach(id => {
      if (!newPropertyIds.has(id)) { markersRef.current[id].remove(); delete markersRef.current[id]; }
    });

    props.forEach(prop => {
      if (prop.latitude && prop.longitude && !markersRef.current[prop.id]) {
        const markerEl = document.createElement('div');
        markerEl.className = 'w-auto px-2 py-1 bg-blue-600 text-white text-xs font-bold border-2 border-white rounded-full cursor-pointer shadow-lg hover:bg-blue-700 transition-all duration-200';
        markerEl.innerHTML = `₹${((prop.price || 0) / 100000).toFixed(0)}L`;
        
        const popup = new Popup({ offset: 25, closeButton: false }).setHTML(`<div class="p-1"><div class="font-bold text-sm">${prop.title}</div><div class="text-xs">₹${prop.price?.toLocaleString()}</div></div>`);
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
      setBhkTypes(bhkRes.data || []);
      setPropertyTypes(propTypeRes.data || []);
    };
    init();

    if (mapRef.current) return; 
    if (!mapContainer.current || !process.env.NEXT_PUBLIC_MAPTILER_KEY) return;

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
        setLocationError("Geolocation is not supported by your browser.");
        return;
    }
    
    setIsLocating(true);
    setLocationError(null);
    setSearchAsIMove(true);

    navigator.geolocation.getCurrentPosition(
        (position) => {
            if(mapRef.current) {
                mapRef.current.flyTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 14 });
            }
            setIsLocating(false);
        },
        (err) => {
            console.error("Error getting location:", err);
            setLocationError("Could not get your location. Please enable location permissions in your browser settings.");
            setIsLocating(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };
  
  return (
    <div className="flex flex-col h-screen bg-gray-100">
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <aside className={cn("w-full md:w-[450px] md:flex-shrink-0 p-4 bg-white border-r flex flex-col", "md:flex", mobileView === 'list' ? "flex" : "hidden")}>
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Explore Properties</h2>
          <div className="space-y-4">
              <input type="text" name="location" placeholder="Search by location..." value={filters.location} onChange={handleFilterChange} className="w-full p-2 border rounded-md"/>
              <div className="grid grid-cols-2 gap-2">
                <input type="number" name="minPrice" placeholder="Min Price" value={filters.minPrice} onChange={handleFilterChange} className="w-full p-2 border rounded-md"/>
                <input type="number" name="maxPrice" placeholder="Max Price" value={filters.maxPrice} onChange={handleFilterChange} className="w-full p-2 border rounded-md"/>
              </div>
              <div className="grid grid-cols-2 gap-2">
                  <select name="bhkTypeId" value={filters.bhkTypeId} onChange={handleFilterChange} className="w-full p-2 border rounded-md bg-white text-sm"><option value="">Any BHK</option>{bhkTypes.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
                  <select name="propertyTypeId" value={filters.propertyTypeId} onChange={handleFilterChange} className="w-full p-2 border rounded-md bg-white text-sm"><option value="">Any Type</option>{propertyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </div>
              <div className="flex items-center justify-between bg-gray-100 p-2 rounded-md">
                <label htmlFor="search-as-i-move" className="text-sm font-medium text-gray-700">Search as I move the map</label>
                <input id="search-as-i-move" type="checkbox" checked={searchAsIMove} onChange={() => setSearchAsIMove(!searchAsIMove)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"/>
              </div>
              <button onClick={handleApplyFilters} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded w-full">Apply Filters</button>
              <div>
                <button onClick={useUserLocation} disabled={isLocating} className="bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold py-2 px-4 rounded w-full flex items-center justify-center gap-2 disabled:opacity-50">
                    {isLocating ? <FaSpinner className="animate-spin"/> : <FaCrosshairs/>} {isLocating ? 'Locating...' : 'Use My Location'}
                </button>
                {locationError && <p className="text-xs text-red-500 mt-1 text-center">{locationError}</p>}
              </div>
          </div>
          <div className="border-t my-4"></div>
          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            {loading ? <div className="flex justify-center items-center h-full"><FaSpinner className="animate-spin text-3xl text-gray-400" /></div>
             : properties.length > 0 ? properties.map(property => (
                <div key={property.id} onMouseEnter={() => highlightMarker(property.id)} onMouseLeave={() => highlightMarker(null)} className="bg-white border rounded-lg shadow-sm hover:shadow-md hover:border-blue-500 transition-all cursor-pointer overflow-hidden">
                   <Link href={`/property/${property.id}`} className="block">
                        <div className="w-full h-40 bg-gray-200">
                            <img src={property.image_url || 'https://placehold.co/600x400/eee/ccc?text=No+Image'} alt={`Image of ${property.title}`} className="w-full h-full object-cover"/>
                        </div>
                        <div className="p-3">
                            <h3 className="font-bold text-md truncate">{property.title}</h3>
                            <p className="text-sm text-gray-500 flex items-center gap-1"><FaMapMarkerAlt size={12}/> {property.location_text}</p>
                            <p className="text-lg text-green-700 font-semibold mt-1">₹{property.price?.toLocaleString() || 'N/A'}</p>
                            <p className="text-xs text-gray-600">{property.area_sqft} sqft • {property.bhk_type}</p>
                        </div>
                   </Link>
                </div>
            )) : <p className="text-center text-gray-500 mt-10">No properties found. Try moving the map or changing filters.</p>}
          </div>
        </aside>

        <main className={cn("flex-1 relative", "md:flex", mobileView === 'map' ? "flex" : "hidden")}>
          <div ref={mapContainer} className="w-full h-full" />
           {loading && <div className="absolute top-4 right-20 bg-white p-2 rounded-full shadow-lg"><FaSpinner className="animate-spin text-blue-500" /></div>}
        </main>
      </div>

       <div className="md:hidden fixed bottom-6 right-6 z-20">
            <button onClick={() => setMobileView(v => v === 'list' ? 'map' : 'list')} className="flex items-center justify-center gap-2 bg-white text-blue-600 font-semibold py-3 px-4 rounded-full shadow-lg border">
                {mobileView === 'list' ? <FaMap/> : <FaList/>}
                <span>{mobileView === 'list' ? 'Map' : 'List'}</span>
            </button>
        </div>
    </div>
  );
}
