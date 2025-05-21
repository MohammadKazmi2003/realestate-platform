'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import PropertyMapCard from '@/app/components/PropertyMapCard';
import ReactDOM from 'react-dom/client';

const DEFAULT_CENTER = { lat: 19.0330, lng: 73.0297 };
const GEOLOCATION_TIMEOUT = 15000;

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([])
  const circleRef = useRef<maplibregl.GeoJSONSource | null>(null);
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const router = useRouter();
  const [radius, setRadius] = useState<number>(2);
  const [centerCoords, setCenterCoords] = useState<{ lat: number; lng: number }>(DEFAULT_CENTER);
  const [properties, setProperties] = useState<any[]>([]); // Added type for properties
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

  const createPopupContent = useCallback((property: any) => {
    const popupDiv = document.createElement('div');
    const root = ReactDOM.createRoot(popupDiv);
    root.render(<PropertyMapCard {...property} />);
    return popupDiv;
  }, []);

  const addMarkers = useCallback((props: any[]) => {
    const tempCards: HTMLDivElement[] = [];
    props.forEach(({ id, title, location, price, area_sqft, latitude, longitude }) => {
      if (latitude && longitude) {
        const marker = new maplibregl.Marker()
          .setLngLat([longitude, latitude])
          .addTo(mapRef.current!);
        const markerElement = marker.getElement();
        markerElement.addEventListener('mouseenter', (e) => {
          e.preventDefault();
          const card = document.createElement('div');
          card.className = 'hover-property-card bg-white p-2 rounded shadow-lg border border-gray-200'; // Added some styling
          card.innerHTML = `
            <div class="font-bold text-sm">${title}</div>
            <div class="text-xs text-gray-600">${location}</div>
            <div class="text-xs text-green-700 font-semibold">₹${price?.toLocaleString() || 'N/A'}</div>
          `;
          const markerRect = markerElement.getBoundingClientRect();
          const mapContainerRect = mapContainer.current?.getBoundingClientRect();

          card.style.position = 'absolute';
          // Adjust position to be relative to the map container if possible
          if (mapContainerRect) {
            card.style.left = `${markerRect.left - mapContainerRect.left + markerRect.width / 2 + 10}px`;
            card.style.top = `${markerRect.top - mapContainerRect.top - card.offsetHeight / 2}px`;
          } else {
            // Fallback to body relative positioning (might be less accurate if map scrolls within body)
            card.style.left = `${markerRect.left + window.scrollX + markerRect.width / 2 + 10}px`;
            card.style.top = `${markerRect.top + window.scrollY - card.offsetHeight / 2}px`;
          }
          card.style.zIndex = '1000';
          (mapContainer.current || document.body).appendChild(card); // Append to map container or body
          tempCards.push(card);
        });
        markerElement.addEventListener('mouseleave', (e) => {
          e.preventDefault();
          tempCards.forEach(card => card.remove());
          tempCards.length = 0;
        });
        markerElement.addEventListener('click', () => router.push(`/property/${id}`));
        markersRef.current.push(marker);
      }
    });
  }, [router]);

  const fetchProperties = useCallback(
    async (
      lat: number,
      lng: number,
      radius: number,
      propertyTypeFilter: string | null,
      bhkFilter: string | null,
      minPriceFilter: number | null,
      maxPriceFilter: number | null,
      minAreaFilter: number | null,
      maxAreaFilter: number | null,
      locationFilter: string | null
    ) => {
      let query = supabase.rpc('get_properties_within_radius', { lat, lng, radius_km: radius });
      if (propertyTypeFilter && propertyTypeFilter !== '') query = query.eq('property_type', propertyTypeFilter);
      if (bhkFilter && bhkFilter !== '') query = query.eq('bhk', bhkFilter);
      if (minPriceFilter !== null) query = query.gte('price', minPriceFilter);
      if (maxPriceFilter !== null) query = query.lte('price', maxPriceFilter);
      if (minAreaFilter !== null) query = query.gte('area_sqft', minAreaFilter);
      if (maxAreaFilter !== null) query = query.lte('area_sqft', maxAreaFilter);
      if (locationFilter && locationFilter !== '') query = query.ilike('location', `%${locationFilter}%`);
      const { data, error } = await query;
      if (error) console.error('Error fetching properties:', error);
      return data || [];
    },
    []
  );

  const clearMarkers = useCallback(() => {
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
  }, []);

  const drawCircle = useCallback((center: { lat: number; lng: number }, radiusInKm: number) => {
    if (!mapRef.current || !mapRef.current.isStyleLoaded()) return;
    const R = 6371; // Earth's radius in km
    const points: [number, number][] = [];
    const numSides = 64;
    const centerLatRad = center.lat * Math.PI / 180;
    const centerLngRad = center.lng * Math.PI / 180;
    const d = radiusInKm / R; // angular distance in radians

    for (let i = 0; i <= numSides; i++) {
      const angle = (i * 2 * Math.PI) / numSides;
      const latRad = Math.asin(Math.sin(centerLatRad) * Math.cos(d) + Math.cos(centerLatRad) * Math.sin(d) * Math.cos(angle));
      let lngRad = centerLngRad + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(centerLatRad), Math.cos(d) - Math.sin(centerLatRad) * Math.sin(latRad));
      // Normalize lngRad to be between -PI and PI
      lngRad = (lngRad + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      points.push([lngRad * 180 / Math.PI, latRad * 180 / Math.PI]);
    }
    const circleGeoJSON: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [points],
            },
            properties: {}
        }]
    };

    if (circleRef.current) {
      circleRef.current.setData(circleGeoJSON);
    } else if (mapRef.current.getSource('radius-circle')) { // Check if source already exists
        (mapRef.current.getSource('radius-circle') as maplibregl.GeoJSONSource).setData(circleGeoJSON);
        circleRef.current = mapRef.current.getSource('radius-circle') as maplibregl.GeoJSONSource;
    }
    else {
      mapRef.current!.addSource('radius-circle', { type: 'geojson', data: circleGeoJSON });
      circleRef.current = mapRef.current!.getSource('radius-circle') as maplibregl.GeoJSONSource;
      mapRef.current!.addLayer({ id: 'radius-circle-layer', type: 'fill', source: 'radius-circle', paint: { 'fill-color': '#00aaff', 'fill-opacity': 0.2 } });
    }
  }, []);

  const addCenterMarker = useCallback((center: { lat: number; lng: number }) => {
    if (!mapRef.current) return;
    if (centerMarkerRef.current) {
      centerMarkerRef.current.setLngLat([center.lng, center.lat]);
    } else {
      centerMarkerRef.current = new maplibregl.Marker({ color: 'red' })
        .setLngLat([center.lng, center.lat])
        .addTo(mapRef.current!);
    }
  }, []);

  const updateMap = useCallback(async (newCenter: { lat: number; lng: number }, newRadius: number) => {
    if (mapRef.current && mapRef.current.isStyleLoaded()) {
      // mapRef.current.flyTo({ center: [newCenter.lng, newCenter.lat], zoom: 10 }); // Consider adjusting zoom based on radius or keeping it fixed
      const props = await fetchProperties(newCenter.lat, newCenter.lng, newRadius, propertyType, bhk, minPrice ? parseInt(minPrice) : null, maxPrice ? parseInt(maxPrice) : null, minArea ? parseInt(minArea) : null, maxArea ? parseInt(maxArea) : null, locationFilter);
      setProperties(props);
      clearMarkers();
      addMarkers(props);
      drawCircle(newCenter, newRadius);
      addCenterMarker(newCenter);
    }
  }, [fetchProperties, clearMarkers, addMarkers, drawCircle, addCenterMarker, propertyType, bhk, minPrice, maxPrice, minArea, maxArea, locationFilter]); // Removed radius and centerCoords as they are passed directly or derived

  const initMap = useCallback(() => {
    if (mapContainer.current && !mapRef.current) {
      mapRef.current = new maplibregl.Map({
        container: mapContainer.current!,
        style: 'https://api.maptiler.com/maps/bright/style.json?key=TrCfekmv7jylPSiqmMwc', // Ensure this key is valid and has access
        center: [centerCoords.lng, centerCoords.lat],
        zoom: 10,
      });
      mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');
      mapRef.current.on('load', () => {
          console.log("Map loaded, updating map with initial coords:", centerCoords, "and radius:", radius);
          updateMap(centerCoords, radius)
        });
      mapRef.current.on('click', (e) => {
        const newCenter = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        setCenterCoords(newCenter);
        // updateMap(newCenter, radius); // Decided to update map only on explicit actions like filter apply or radius change after click
      });
    }
  }, [centerCoords, radius, updateMap]); // updateMap dependency is important here

  useEffect(() => {
    if (viewMode === 'map') {
      initMap();
    } else if (mapRef.current) {
      // Clean up map instance when switching to list view
      mapRef.current.remove();
      mapRef.current = null;
      // No need to call clearMarkers if map is removed, but good to clear refs
      markersRef.current = [];
      circleRef.current = null;
      centerMarkerRef.current = null;
    }
    // Cleanup function for when component unmounts or viewMode changes from 'map'
    return () => {
        if (viewMode === 'map' && mapRef.current) {
            console.log("Cleaning up map on unmount or viewMode change from map");
            // mapRef.current.remove(); // This was causing issues when toggling. Better to handle in the else if.
            // mapRef.current = null;
        }
    };
  }, [viewMode, initMap]); // Removed clearMarkers from here as it's handled by updateMap or viewMode switch

  const handleRadiusChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const r = Number(e.target.value);
    setRadius(r);
    updateMap(centerCoords, r);
  };

  const toggleViewMode = () => {
    setViewMode(prevMode => prevMode === 'map' ? 'list' : 'map');
  };

  const handlePropertyClickInList = useCallback((property: any) => { // Renamed to avoid confusion
    setViewMode('map');
    // Ensure map initializes if not already, then fly
    if (!mapRef.current) {
        setCenterCoords({ lat: property.latitude, lng: property.longitude }); // Set center, initMap will use this
        // initMap will be called by useEffect due to viewMode change
    } else {
        const newCenter = { lat: property.latitude, lng: property.longitude };
        setCenterCoords(newCenter);
        mapRef.current.flyTo({ center: [newCenter.lng, newCenter.lat], zoom: 12 }); // Fly to property
        updateMap(newCenter, radius); // Update map with new center
    }
  }, [radius, updateMap]); // Removed setViewMode, setCenterCoords as they are already used or will trigger effects

  const getUserLocation = () => {
    setLocationLoading(true);
    setLocationError(null);
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setCenterCoords(userCoords);
          if (mapRef.current) { // If map exists, fly to new location
            mapRef.current.flyTo({center: [userCoords.lng, userCoords.lat], zoom: 12});
          }
          updateMap(userCoords, radius);
          setLocationLoading(false);
        },
        (err) => {
          console.error(err);
          setLocationError(err.message === 'User denied Geolocation' ? 'Location access denied.' : (err.message === 'Timeout expired' ? 'Timeout expired while trying to get location.' : err.message));
          setLocationLoading(false);
          // Optionally, fall back to default or last known center
          updateMap(DEFAULT_CENTER, radius);
        },
        { timeout: GEOLOCATION_TIMEOUT, enableHighAccuracy: true }
      );
    } else {
      setLocationError("Geolocation is not supported by this browser.");
      setLocationLoading(false);
      updateMap(DEFAULT_CENTER, radius);
    }
  };

  const applyFilters = useCallback(async () => {
    // If in list view and filters are applied, ideally we should also fetch properties
    // For map view, updateMap already handles fetching with current filters
    if (mapRef.current && mapRef.current.isStyleLoaded()){
        updateMap(centerCoords, radius);
    } else if (viewMode === 'list') {
        // If in list view, just fetch and set properties
        const filteredProperties = await fetchProperties(
            centerCoords.lat,
            centerCoords.lng,
            radius,
            propertyType,
            bhk,
            minPrice ? parseInt(minPrice) : null,
            maxPrice ? parseInt(maxPrice) : null,
            minArea ? parseInt(minArea) : null,
            maxArea ? parseInt(maxArea) : null,
            locationFilter
          );
          setProperties(filteredProperties);
          // No map-specific updates like markers needed for list view
    }
  }, [centerCoords, radius, propertyType, bhk, minPrice, maxPrice, minArea, maxArea, locationFilter, fetchProperties, updateMap, viewMode]); // Added updateMap and viewMode


  // Effect to re-fetch properties when filters change and map is active
  useEffect(() => {
    if (viewMode === 'map' && mapRef.current && mapRef.current.isStyleLoaded()) {
        // Debounce this effect or make it less sensitive if it causes too many re-renders/fetches
        // For now, it will refetch if any filter param changes while map is visible
        updateMap(centerCoords, radius);
    }
  }, [propertyType, bhk, minPrice, maxPrice, minArea, maxArea, locationFilter, viewMode, centerCoords, radius, updateMap]); // Added all relevant dependencies


  return (
    <>
      <div className="flex flex-col md:flex-row w-full h-screen">
        {/* Sidebar for filters */}
        <aside className="w-full md:w-1/4 lg:w-1/5 p-4 bg-gray-100 shadow-md overflow-y-auto">
          <h2 className="text-xl font-semibold mb-4">Filter Properties</h2>
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="radius" className="block text-sm font-medium text-gray-700">Radius (km): {radius} km</label>
              <input type="range" id="radius" min="1" max="25" step="1" className="mt-1 block w-full" value={radius} onChange={handleRadiusChange} />
            </div>

            <div>
              <button onClick={getUserLocation} disabled={locationLoading} className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded disabled:opacity-50">
                {locationLoading ? 'Getting Location...' : 'Use My Location'}
              </button>
              {locationError && <p className="text-red-500 text-xs mt-1">{locationError}</p>}
            </div>

            <div>
              <label htmlFor="propertyType" className="block text-sm font-medium text-gray-700">Property Type:</label>
              <select id="propertyType" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
                <option value="">All</option>
                <option value="Apartment">Apartment</option>
                <option value="House">House</option>
                <option value="Villa">Villa</option>
                <option value="Plot">Plot</option>
              </select>
            </div>

            <div>
              <label htmlFor="bhk" className="block text-sm font-medium text-gray-700">BHK:</label>
              <select id="bhk" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={bhk} onChange={(e) => setBHK(e.target.value)}>
                <option value="">All</option>
                <option value="1">1 BHK</option>
                <option value="2">2 BHK</option>
                <option value="3">3 BHK</option>
                <option value="3+">3+ BHK</option>
              </select>
            </div>

            <div className="flex gap-2">
              <div>
                <label htmlFor="minPrice" className="block text-sm font-medium text-gray-700">Min Price:</label>
                <input type="number" id="minPrice" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} placeholder="Min" />
              </div>
              <div>
                <label htmlFor="maxPrice" className="block text-sm font-medium text-gray-700">Max Price:</label>
                <input type="number" id="maxPrice" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="Max" />
              </div>
            </div>

            <div className="flex gap-2">
              <div>
                <label htmlFor="minArea" className="block text-sm font-medium text-gray-700">Min Area (sqft):</label>
                <input type="number" id="minArea" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={minArea} onChange={(e) => setMinArea(e.target.value)} placeholder="Min" />
              </div>
              <div>
                <label htmlFor="maxArea" className="block text-sm font-medium text-gray-700">Max Area (sqft):</label>
                <input type="number" id="maxArea" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={maxArea} onChange={(e) => setMaxArea(e.target.value)} placeholder="Max" />
              </div>
            </div>

            <div>
              <label htmlFor="locationFilter" className="block text-sm font-medium text-gray-700">Location Search:</label>
              <input type="text" id="locationFilter" className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} placeholder="Search by location name" />
            </div>

            <button onClick={applyFilters} className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded">
              Apply Filters
            </button>

            <button onClick={toggleViewMode} className="mt-2 bg-gray-500 hover:bg-gray-600 text-white font-semibold py-2 px-4 rounded">
              {viewMode === 'map' ? 'Show List View' : 'Show Map View'}
            </button>
          </div>
        </aside>

        {/* Main content area for map or list */}
        <main className="flex-1 h-full">
          {viewMode === 'map' ? (
            <div ref={mapContainer} className="w-full h-full" />
          ) : (
            <div className="p-4 overflow-y-auto h-full">
              <h2 className="text-xl font-semibold mb-4">Properties List ({properties.length})</h2>
              {properties.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {properties.map(property => (
                    <div key={property.id} className="border p-4 rounded shadow hover:shadow-lg cursor-pointer" onClick={() => handlePropertyClickInList(property)}>
                      <h3 className="font-bold text-lg">{property.title}</h3>
                      <p className="text-sm text-gray-600">{property.location}</p>
                      <p className="text-sm text-green-700 font-semibold">₹{property.price?.toLocaleString() || 'N/A'}</p>
                      <p className="text-xs text-gray-500">{property.area_sqft} sqft | {property.bhk} BHK | {property.property_type}</p>
                      {/* Add more property details here if needed */}
                    </div>
                  ))}
                </div>
              ) : (
                <p>No properties found matching your criteria. Try adjusting the filters or radius.</p>
              )}
            </div>
          )}
        </main>
      </div>
    </>
  );
}