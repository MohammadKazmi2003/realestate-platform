'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';
import PropertyMapCard from '@/app/components/PropertyMapCard';
import ReactDOM from 'react-dom/client'; // Import ReactDOM

// Default coordinates
const DEFAULT_CENTER = { lat: 28.4595, lng: 77.0266 };
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
  const [properties, setProperties] = useState([]);
  const [locationLoading, setLocationLoading] = useState<boolean>(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');

  const fetchProperties = useCallback(async (lat: number, lng: number, radius: number) => {
    const { data, error } = await supabase.rpc('get_properties_within_radius', {
      lat,
      lng,
      radius_km: radius,
    });
    if (error) {
      console.error('Error fetching properties:', error);
      return [];
    }
    return data;
  }, []);

  const clearMarkers = useCallback(() => {
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
  }, []);

  const addMarkers = useCallback((props: any[]) => {
    props.forEach(({ id, title, location, price, area_sqft, latitude, longitude }) => {
      if (latitude && longitude) {
        const marker = new maplibregl.Marker()
          .setLngLat([longitude, latitude])
          .setPopup(
            new maplibregl.Popup({ closeButton: true }).setDOMContent(
              createPopupContent({ id, title, location, price, area_sqft })
            )
          )
          .addTo(mapRef.current!);
        marker.getElement().addEventListener('click', () => router.push(`/property/${id}`));
        markersRef.current.push(marker);
      }
    });
  }, [router]);

  const createPopupContent = useCallback((property: any) => {
    const popupDiv = document.createElement('div');
    const root = ReactDOM.createRoot(popupDiv); // Create a root
    root.render(<PropertyMapCard {...property} />); // Render into the root
    return popupDiv;
  }, []);

  const drawCircle = useCallback((center: { lat: number; lng: number }, radiusInKm: number) => {
    if (!mapRef.current || !mapRef.current.isStyleLoaded()) return;
    const R = 6371, points: [number, number][] = [];
    const numSides = 64, centerLat = center.lat * Math.PI / 180, centerLng = center.lng * Math.PI / 180, d = radiusInKm / R;
    for (let i = 0; i <= numSides; i++) {
      const angle = (i * 2 * Math.PI) / numSides;
      const lat = Math.asin(Math.sin(centerLat) * Math.cos(d) + Math.cos(centerLat) * Math.sin(d) * Math.cos(angle));
      const lng = centerLng + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(centerLat), Math.cos(d) - Math.sin(centerLat) * Math.sin(lat));
      points.push([lng * 180 / Math.PI, lat * 180 / Math.PI]);
    }
    const circleGeoJSON = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] }, properties: {} }] };
    if (circleRef.current) {
      circleRef.current.setData(circleGeoJSON);
    } else {
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
      await mapRef.current.flyTo({ center: [newCenter.lng, newCenter.lat], zoom: 10 });
      const props = await fetchProperties(newCenter.lat, newCenter.lng, newRadius);
      setProperties(props);
      clearMarkers();
      addMarkers(props);
      drawCircle(newCenter, newRadius);
      addCenterMarker(newCenter);
    }
  }, [fetchProperties, clearMarkers, addMarkers, drawCircle, addCenterMarker]);

  const initMap = useCallback(() => {
    if (mapContainer.current && !mapRef.current) {
      mapRef.current = new maplibregl.Map({
        container: mapContainer.current!,
        style: 'https://api.maptiler.com/maps/bright/style.json?key=TrCfekmv7jylPSiqmMwc',
        center: [centerCoords.lng, centerCoords.lat],
        zoom: 10,
      });
      mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right');
      mapRef.current.on('load', () => updateMap(centerCoords, radius));
      mapRef.current.on('click', (e) => {
        const newCenter = { lat: e.lngLat.lat, lng: e.lngLat.lng };
        setCenterCoords(newCenter);
        updateMap(newCenter, radius);
      });
    }
  }, [centerCoords, radius, updateMap]);

  useEffect(() => {
    if (viewMode === 'map') {
      initMap();
    } else if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      clearMarkers();
      circleRef.current = null;
      centerMarkerRef.current = null;
    }
  }, [viewMode, initMap, clearMarkers]);

  useEffect(() => {
    setLocationLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCenterCoords(userCoords);
        updateMap(userCoords, radius);
        setLocationLoading(false);
      },
      (err) => {
        console.error(err);
        setLocationError(err.message === 'Timeout' ? 'Timeout expired while trying to get location.' : err.message);
        setLocationLoading(false);
      },
      { timeout: GEOLOCATION_TIMEOUT }
    );
  }, [radius, updateMap]);

  const handleRadiusChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const r = Number(e.target.value);
    setRadius(r);
    updateMap(centerCoords, r);
  };

  const toggleViewMode = () => {
    setViewMode(prevMode => prevMode === 'map' ? 'list' : 'map');
  };

  const handlePropertyClick = useCallback((property: any) => {
    setViewMode('map');
    setCenterCoords({ lat: property.latitude, lng: property.longitude });
  }, [setViewMode, setCenterCoords]);

  return (
    <div className="flex flex-col md:flex-row w-full h-screen">
      {/* Controls */}
      <div className="absolute z-10 top-4 left-4 bg-white p-2 rounded shadow flex flex-col gap-2">
        <button onClick={toggleViewMode} className="bg-gray-700 text-white text-sm px-4 py-2 rounded">
          Toggle to {viewMode === 'map' ? 'List' : 'Map'} View
        </button>
        <label className="text-sm mt-1">Radius: {radius} km</label>
        <input type="range" min={1} max={25} value={radius} onChange={handleRadiusChange} />
        {locationError && <p className="text-red-500 text-xs">{locationError}</p>}
        {locationLoading && <p className="text-gray-500 text-xs">Getting location...</p>}
      </div>

      {/* Map View */}
      {viewMode === 'map' && (
        <div ref={mapContainer} className="w-full h-full" />
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <div className="w-full md:w-1/2 p-4 overflow-y-auto">
          <h2 className="text-xl font-semibold mb-4">Properties in {radius} km radius</h2>
          {properties.length === 0 ? (
            <p>No properties found.</p>
          ) : (
            <ul className="space-y-4">
              {properties.map((property) => (
                <li
                  key={property.id}
                  className="border p-3 rounded cursor-pointer hover:bg-gray-100"
                  onClick={() => handlePropertyClick(property)}
                >
                  <h3 className="font-bold text-lg">{property.title}</h3>
                  <p className="text-sm text-gray-600">{property.description?.slice(0, 100)}...</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}