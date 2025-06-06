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
  id: string;
  title: string | null;
  price?: number | null;
  location_text: string | null;
  bhk_type: string | null;
  area_sqft: number | null;
  latitude: number | null;
  longitude: number | null;
  user_id?: string;
  image_url: string | null; // Added image_url
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

export default function BrowsePage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<{ [key: string]: Marker }>({});
  const router = useRouter();

  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [filters, setFilters] = useState({ location: '', minPrice: '', maxPrice: '', bhkTypeId: '', propertyTypeId: '' });
  const [bhkTypes, setBhkTypes] = useState<BhkType[]>([]);
  const [propertyTypes, setPropertyTypes] = useState<PropertyType[]>([]);
  
  const fetchProperties = useCallback(async (bounds: LngLatBounds) => {
    setLoading(true);
    const { _ne, _sw } = bounds;
    const params = {
      min_lat: _sw.lat, max_lat: _ne.lat, min_lng: _sw.lng, max_lng: _ne.lng,
      p_location_text: filters.location || null,
      p_min_price: filters.minPrice ? Number(filters.minPrice) : null,
      p_max_price: filters.maxPrice ? Number(filters.maxPrice) : null,
      p_bhk_type_id: filters.bhkTypeId ? Number(filters.bhkTypeId) : null,
      p_property_type_id: filters.propertyTypeId ? Number(filters.propertyTypeId) : null,
    };
    const { data, error } = await supabase.rpc('search_properties', params);
    if (error) console.error('Error fetching properties:', error);
    else setProperties(data || []);
    setLoading(false);
  }, [filters]);

  const debouncedFetchProperties = useDebouncedCallback(fetchProperties, 600);

  const highlightMarker = (propertyId: string | null) => {
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
  };

  const updateMarkers = useCallback((props: Property[]) => {
    if (!mapRef.current) return;
    const newPropertyIds = new Set(props.map(p => p.id));
    Object.keys(markersRef.current).forEach(id => {
      if (!newPropertyIds.has(id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });

    props.forEach(prop => {
      if (prop.latitude && prop.longitude && !markersRef.current[prop.id]) {
        const markerEl = document.createElement('div');
        markerEl.className = 'px-2 py-1 bg-blue-600 text-white text-xs font-bold border-2 border-white rounded-full cursor-pointer shadow-lg hover:bg-blue-700 transition-all duration-200';
        markerEl.innerHTML = `₹${((prop.price || 0) / 100000).toFixed(0)}L`;
        
        const popup = new Popup({ offset: 25, closeButton: false }).setHTML(`<div class="p-1"><div class="font-bold text-sm">${prop.title}</div><div class="text-xs">₹${prop.price?.toLocaleString()}</div></div>`);
        const marker = new Marker({ element: markerEl, anchor: 'bottom' })
          .setLngLat([prop.longitude, prop.latitude]).addTo(mapRef.current!);
        
        marker.getElement().addEventListener('click', () => router.push(`/property/${prop.id}`));
        marker.getElement().addEventListener('mouseenter', () => popup.setLngLat([prop.longitude!, prop.latitude!]).addTo(mapRef.current!));
        marker.getElement().addEventListener('mouseleave', () => popup.remove());
        markersRef.current[prop.id] = marker;
      }
    });
  }, [router]);

  useEffect(() => { updateMarkers(properties); }, [properties, updateMarkers]);

  useEffect(() => {
    const fetchDropdowns = async () => {
      const [bhkRes, propTypeRes] = await Promise.all([
        supabase.from('bhk_types').select('*'), supabase.from('property_types').select('*'),
      ]);
      setBhkTypes(bhkRes.data || []);
      setPropertyTypes(propTypeRes.data || []);
    };
    fetchDropdowns();

    if (mapRef.current || !mapContainer.current || !process.env.NEXT_PUBLIC_MAPTILER_KEY) return; 

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current!,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`,
      center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM,
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    const onMapInteraction = () => mapRef.current && debouncedFetchProperties(mapRef.current.getBounds());
    mapRef.current.on('load', onMapInteraction);
    mapRef.current.on('moveend', onMapInteraction);
    
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [debouncedFetchProperties]);

  const handleFilterChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleApplyFilters = async () => {
    if (filters.location && process.env.NEXT_PUBLIC_MAPTILER_KEY) {
      const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(filters.location)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`);
      const data = await response.json();
      if (data.features && data.features.length > 0) {
        mapRef.current?.flyTo({ center: data.features[0].center, zoom: 13 });
      }
    } else {
        if(mapRef.current) fetchProperties(mapRef.current.getBounds());
    }
  };
  
  const useUserLocation = () => {
    navigator.geolocation.getCurrentPosition((position) => {
        const { latitude, longitude } = position.coords;
        mapRef.current?.flyTo({ center: [longitude, latitude], zoom: 14 });
    }, (err) => console.error("Error getting location:", err));
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
              <button onClick={handleApplyFilters} className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded w-full">Apply Filters</button>
              <button onClick={useUserLocation} className="bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold py-2 px-4 rounded w-full flex items-center justify-center gap-2"><FaCrosshairs/> Use My Location</button>
          </div>
          <div className="border-t my-4"></div>
          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            {loading ? <div className="flex justify-center items-center h-full"><FaSpinner className="animate-spin text-3xl text-gray-400" /></div>
             : properties.length > 0 ? properties.map(property => (
                <div key={property.id} onMouseEnter={() => highlightMarker(property.id)} onMouseLeave={() => highlightMarker(null)} className="bg-white border rounded-lg shadow-sm hover:shadow-md hover:border-blue-500 transition-all cursor-pointer overflow-hidden">
                   <Link href={`/property/${property.id}`}>
                        <div className="w-full h-40 bg-gray-200">
                            <img
                                src={property.image_url || 'https://placehold.co/600x400/eee/ccc?text=No+Image'}
                                alt={`Image of ${property.title}`}
                                className="w-full h-full object-cover"
                                onError={(e) => { e.currentTarget.src = 'https://placehold.co/600x400/eee/ccc?text=No+Image'; }}
                            />
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

       <div className="md:hidden absolute bottom-6 right-6 z-20">
            <button onClick={() => setMobileView(v => v === 'list' ? 'map' : 'list')} className="flex items-center justify-center gap-2 bg-white text-blue-600 font-semibold py-3 px-4 rounded-full shadow-lg">
                {mobileView === 'list' ? <FaMap/> : <FaList/>}
                <span>{mobileView === 'list' ? 'Map' : 'List'}</span>
            </button>
        </div>
    </div>
  );
}
