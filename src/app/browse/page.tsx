// src/app/browse/page.tsx
'use client';

import React from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

type Property = {
  id: string;
  title: string | null;
  description?: string | null;
  price?: number | null;
  property_type_id?: number | null;
  listing_type_id?: number | null;
  bhk_type_id?: number | null;
  location_text: string | null;
  bhk_type: string | null;
  area_sqft: number | null;
  user_id?: string | null;
  latitude: number | null;
  longitude: number | null;
  property_type_name_from_join?: string | null;
  bhk_label_from_join?: string | null;
};

const DEFAULT_CENTER = { lat: 19.0330, lng: 73.0297 };
const GEOLOCATION_TIMEOUT = 15000;

export default function BrowsePage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const router = useRouter();

  const [radius, setRadius] = useState<number>(5);
  const [centerCoords, setCenterCoords] = useState<{ lat: number; lng: number }>(DEFAULT_CENTER);
  const [properties, setProperties] = useState<Property[]>([]);
  const [locationLoading, setLocationLoading] = useState<boolean>(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');

  const [propertyType, setPropertyType] = useState('');
  const [bhk, setBHK] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minArea, setMinArea] = useState('');
  const [maxArea, setMaxArea] = useState('');
  const [locationFilter, setLocationFilter] = useState('');

  const clearMarkers = useCallback(() => {
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
  }, []);

  const addMarkers = useCallback((props: Property[]) => {
    if (!mapRef.current) return;
    let tempCards: HTMLDivElement[] = [];
    props.forEach((prop) => {
      if (prop.latitude != null && prop.longitude != null) {
        const marker = new maplibregl.Marker().setLngLat([prop.longitude, prop.latitude]).addTo(mapRef.current!);
        const markerElement = marker.getElement();
        markerElement.style.cursor = 'pointer';
        markerElement.addEventListener('mouseenter', () => {
          tempCards.forEach(card => card.remove()); tempCards.length = 0;
          const card = document.createElement('div');
          card.className = 'hover-property-card bg-white p-2 rounded shadow-lg border border-gray-200 text-xs';
          card.style.position = 'absolute'; card.style.zIndex = '1000';
          card.innerHTML = `<div class="font-bold">${prop.title || 'N/A'}</div><div>${prop.location_text || 'N/A'}</div><div class="text-green-700 font-semibold">₹${prop.price?.toLocaleString() || 'N/A'}</div>`;
          const markerRect = markerElement.getBoundingClientRect();
          const mapContainerRect = mapContainer.current?.getBoundingClientRect();
          if (mapContainerRect) {
            card.style.left = `${markerRect.left - mapContainerRect.left + markerRect.width + 5}px`;
            card.style.top = `${markerRect.top - mapContainerRect.top}px`;
          }
          (mapContainer.current || document.body).appendChild(card); tempCards.push(card);
        });
        markerElement.addEventListener('mouseleave', (e) => { if (!tempCards.some(card => card.contains(e.relatedTarget as Node))) { tempCards.forEach(c => c.remove()); tempCards.length = 0; }});
        markerElement.addEventListener('click', () => router.push(`/property/${prop.id}`));
        markersRef.current.push(marker);
      } else { console.warn("Property missing lat/lng in addMarkers:", prop.title, prop.id); }
    });
  }, [router, mapContainer]);

  const addCenterMarker = useCallback((center: { lat: number; lng: number }) => {
    if (!mapRef.current) return;
    if (centerMarkerRef.current) { centerMarkerRef.current.setLngLat([center.lng, center.lat]); }
    else { centerMarkerRef.current = new maplibregl.Marker({ color: 'red' }).setLngLat([center.lng, center.lat]).addTo(mapRef.current!); }
  }, []);

  const drawCircle = useCallback((center: { lat: number; lng: number }, radiusInKm: number) => {
    if (!mapRef.current || !mapRef.current.isStyleLoaded()) return;
    const R = 6371; const points: [number, number][] = []; const numSides = 64;
    const centerLatRad = center.lat * Math.PI / 180; const centerLngRad = center.lng * Math.PI / 180; const d = radiusInKm / R;
    for (let i = 0; i <= numSides; i++) { const angle = (i * 2 * Math.PI) / numSides; const latRad = Math.asin(Math.sin(centerLatRad) * Math.cos(d) + Math.cos(centerLatRad) * Math.sin(d) * Math.cos(angle)); let lngRad = centerLngRad + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(centerLatRad), Math.cos(d) - Math.sin(centerLatRad) * Math.sin(latRad)); lngRad = (lngRad + 3 * Math.PI) % (2 * Math.PI) - Math.PI; points.push([lngRad * 180 / Math.PI, latRad * 180 / Math.PI]); }
    const circleGeoJSON: GeoJSON.FeatureCollection<GeoJSON.Polygon> = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] }, properties: {} }] };
    const sourceId = 'radius-circle'; const layerId = 'radius-circle-layer';
    let source = mapRef.current.getSource(sourceId) as maplibregl.GeoJSONSource;
    if (source) { source.setData(circleGeoJSON); } else { if (!mapRef.current.getSource(sourceId)) { mapRef.current.addSource(sourceId, { type: 'geojson', data: circleGeoJSON }); mapRef.current.addLayer({ id: layerId, type: 'fill', source: sourceId, paint: { 'fill-color': '#00aaff', 'fill-opacity': 0.2 } }); } }
  }, []);

  const fetchProperties = useCallback( async ( lat: number, lng: number, currentRadius: number, currentPropertyType: string | null, currentBhk: string | null, currentMinPrice: number | null, currentMaxPrice: number | null, currentMinAreaVal: number | null, currentMaxAreaVal: number | null, currentLocationText: string | null ): Promise<Property[]> => {
    const rpcParams = { center_lat: lat, center_lng: lng, radius_km: currentRadius, filter_property_type_name: (currentPropertyType && currentPropertyType !== '') ? currentPropertyType : null, filter_bhk_label: (currentBhk && currentBhk !== '') ? currentBhk : null, filter_min_price: currentMinPrice, filter_max_price: currentMaxPrice, filter_min_area: currentMinAreaVal, filter_max_area: currentMaxAreaVal, filter_location_text: (currentLocationText && currentLocationText !== '') ? currentLocationText : null, };
    const { data, error } = await supabase.rpc('get_properties_within_radius', rpcParams);
    if (error) { console.error('Error fetching properties from RPC:', error.message || JSON.stringify(error)); setProperties([]); return []; }
    console.log("Properties fetched via RPC:", data);
    setProperties((data as Property[]) || []); return (data as Property[]) || [];
  }, [supabase]);

  const updateMapData = useCallback(async (newCenter: { lat: number; lng: number }, newRadius: number) => {
    const props = await fetchProperties( newCenter.lat, newCenter.lng, newRadius, propertyType, bhk, minPrice ? parseFloat(minPrice) : null, maxPrice ? parseFloat(maxPrice) : null, minArea ? parseFloat(minArea) : null, maxArea ? parseFloat(maxArea) : null, locationFilter );
    clearMarkers(); addMarkers(props);
    if (mapRef.current && mapRef.current.isStyleLoaded()) { drawCircle(newCenter, newRadius); addCenterMarker(newCenter); }
  }, [fetchProperties, clearMarkers, addMarkers, drawCircle, addCenterMarker, propertyType, bhk, minPrice, maxPrice, minArea, maxArea, locationFilter]);

  // MODIFIED initMap: Dependencies changed to stabilize it.
  const initMap = useCallback(() => {
    if (mapContainer.current && !mapRef.current) {
      console.log("initMap: Creating new map instance with initial center:", centerCoords, "and zoom: 10");
      mapRef.current = new maplibregl.Map({
        container: mapContainer.current!,
        style: `https://api.maptiler.com/maps/bright/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`,
        center: [centerCoords.lng, centerCoords.lat], // Uses centerCoords state for initial center
        zoom: 10,
      });
      mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');
      mapRef.current.on('load', () => {
        console.log("Map 'load' event: Drawing initial elements and fetching data.");
        // These will use the current values of centerCoords and radius from state
        drawCircle(centerCoords, radius);
        addCenterMarker(centerCoords);
        updateMapData(centerCoords, radius);
      });
      mapRef.current.on('click', (e) => {
        const newCenter = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        console.log("Map clicked, setting new centerCoords:", newCenter);
        setCenterCoords(newCenter);
      });
    }
  // updateMapData, drawCircle, addCenterMarker are stable callbacks.
  // By removing centerCoords and radius from here, initMap itself becomes more stable.
  }, [updateMapData, drawCircle, addCenterMarker]); // Stable dependency array for initMap

  const handlePropertyClickInList = useCallback((property: Property) => { setViewMode('map'); if(property.latitude && property.longitude) setCenterCoords({ lat: property.latitude, lng: property.longitude }); }, []);
  const applyFilters = useCallback(() => { if (viewMode === 'map' && mapRef.current && mapRef.current.isStyleLoaded()) { updateMapData(centerCoords, radius); } else if (viewMode === 'list') { fetchProperties( centerCoords.lat, centerCoords.lng, radius, propertyType, bhk, minPrice ? parseFloat(minPrice) : null, maxPrice ? parseFloat(maxPrice) : null, minArea ? parseFloat(minArea) : null, maxArea ? parseFloat(maxArea) : null, locationFilter ); } }, [centerCoords, radius, propertyType, bhk, minPrice, maxPrice, minArea, maxArea, locationFilter, fetchProperties, updateMapData, viewMode]);
  const handleRadiusChange = (e: React.ChangeEvent<HTMLInputElement>) => setRadius(Number(e.target.value));
  const toggleViewMode = () => setViewMode(prevMode => prevMode === 'map' ? 'list' : 'map');
  const getUserLocation = () => { setLocationLoading(true); setLocationError(null); if (navigator.geolocation) { navigator.geolocation.getCurrentPosition( (pos) => { setCenterCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocationLoading(false); }, (err) => { console.error("Geolocation error:", err); setLocationError(err.message); setLocationLoading(false); }, { timeout: GEOLOCATION_TIMEOUT, enableHighAccuracy: true } ); } else { setLocationError("Geolocation is not supported."); setLocationLoading(false); } };

  // MODIFIED useEffect for initializing and cleaning up the map
  useEffect(() => {
    console.log("useEffect[viewMode, initMap] triggered. viewMode:", viewMode);
    if (viewMode === 'map') {
      initMap();
    }
    return () => {
      console.log("useEffect[viewMode, initMap] cleanup. Current mapRef:", mapRef.current);
      if (centerMarkerRef.current) { centerMarkerRef.current.remove(); centerMarkerRef.current = null; }
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [viewMode, initMap]); // initMap is stable, so this runs mainly on viewMode change

  // MODIFIED useEffect for reacting to centerCoords or radius changes
  useEffect(() => {
    console.log("useEffect[centerCoords, radius, viewMode] triggered.");
    if (viewMode === 'map' && mapRef.current && mapRef.current.isStyleLoaded()) {
      const currentZoom = mapRef.current.getZoom();
      console.log(`Updating map view. Current Zoom: ${currentZoom}, Target Center: [${centerCoords.lng}, ${centerCoords.lat}]`);
      mapRef.current.flyTo({
        center: [centerCoords.lng, centerCoords.lat],
        zoom: currentZoom, // Maintain current zoom
        essential: true
      });
      updateMapData(centerCoords, radius);
    } else if (viewMode === 'list' && properties.length === 0 && !locationLoading) {
      console.log("useEffect[centerCoords, radius, viewMode]: Fetching for list view.");
      applyFilters();
    }
  }, [centerCoords, radius, viewMode, updateMapData, properties.length, applyFilters, locationLoading]);

  return (
    <>
      <div className="flex flex-col md:flex-row w-full h-screen">
        <aside className="w-full md:w-1/4 lg:w-1/5 p-4 bg-gray-100 shadow-md overflow-y-auto">
          <h2 className="text-xl font-semibold mb-4">Filter Properties</h2>
           <div className="flex flex-col gap-4">
            <div><button onClick={getUserLocation} disabled={locationLoading} className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded disabled:opacity-50">{locationLoading ? 'Locating...' : 'Use My Location'}</button>{locationError && <p className="text-red-500 text-xs mt-1">{locationError}</p>}</div>
            <div><label htmlFor="radius" className="block text-sm font-medium text-gray-700">Radius (km): {radius} km</label><input type="range" id="radius" min="1" max="25" step="1" className="mt-1 block w-full" value={radius} onChange={handleRadiusChange} /></div>
            <div><label htmlFor="propertyType" className="block text-sm font-medium text-gray-700">Property Type:</label><select id="propertyType" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={propertyType} onChange={(e) => setPropertyType(e.target.value)}><option value="">All</option><option value="Apartment">Apartment</option><option value="House">House</option><option value="Villa">Villa</option><option value="Plot">Plot</option></select></div>
            <div><label htmlFor="bhk" className="block text-sm font-medium text-gray-700">BHK:</label><select id="bhk" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={bhk} onChange={(e) => setBHK(e.target.value)}><option value="">All</option><option value="1 BHK">1 BHK</option><option value="2 BHK">2 BHK</option><option value="3 BHK">3 BHK</option><option value="3+ BHK">3+ BHK</option></select></div>
            <div className="flex gap-2"><div><label htmlFor="minPrice" className="block text-sm font-medium text-gray-700">Min Price:</label><input type="number" id="minPrice" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} placeholder="Min" /></div><div><label htmlFor="maxPrice" className="block text-sm font-medium text-gray-700">Max Price:</label><input type="number" id="maxPrice" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="Max" /></div></div>
            <div className="flex gap-2"><div><label htmlFor="minArea" className="block text-sm font-medium text-gray-700">Min Area (sqft):</label><input type="number" id="minArea" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={minArea} onChange={(e) => setMinArea(e.target.value)} placeholder="Min" /></div><div><label htmlFor="maxArea" className="block text-sm font-medium text-gray-700">Max Area (sqft):</label><input type="number" id="maxArea" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={maxArea} onChange={(e) => setMaxArea(e.target.value)} placeholder="Max" /></div></div>
            <div><label htmlFor="locationFilter" className="block text-sm font-medium text-gray-700">Location Search:</label><input type="text" id="locationFilter" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} placeholder="Search by location name" /></div>
            <button onClick={applyFilters} className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded">Apply Filters</button>
            <button onClick={toggleViewMode} className="mt-2 bg-gray-500 hover:bg-gray-600 text-white font-semibold py-2 px-4 rounded">{viewMode === 'map' ? 'Show List View' : 'Show Map View'}</button>
          </div>
        </aside>
        <main className="flex-1 h-full">
          {viewMode === 'map' ? (
            <div ref={mapContainer} className="w-full h-full" />
          ) : (
            <div className="p-4 overflow-y-auto h-full">
              <h2 className="text-xl font-semibold mb-4">Properties List ({properties.length})</h2>
              {properties.length > 0 ? ( <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"> {properties.map(property => ( <div key={property.id} className="border p-4 rounded shadow hover:shadow-lg cursor-pointer" onClick={() => handlePropertyClickInList(property)}> <h3 className="font-bold text-lg">{property.title}</h3> <p className="text-sm text-gray-600">{property.location_text}</p> <p className="text-sm text-green-700 font-semibold">₹{property.price?.toLocaleString() || 'N/A'}</p> <p className="text-xs text-gray-500">{property.area_sqft} sqft | {property.bhk_label_from_join || property.bhk_type || 'N/A'} | {property.property_type_name_from_join || 'N/A'}</p> </div> ))} </div> ) : ( <p>No properties found matching your criteria or still loading...</p> )}
            </div>
          )}
        </main>
      </div>
    </>
  );
}