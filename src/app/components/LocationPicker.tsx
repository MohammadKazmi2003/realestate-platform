// src/app/components/LocationPicker.tsx
'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { Marker } from 'maplibre-gl';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { FaMapMarkerAlt } from 'react-icons/fa';

type LocationPickerProps = {
  onLocationChange: (lat: number, lng: number) => void;
  initialPosition?: { lat: number, lng: number };
};

type GeoJsonFeature = {
  place_name: string;
  center: [number, number];
};

const LocationPicker: React.FC<LocationPickerProps> = ({ onLocationChange, initialPosition }) => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<Marker | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<GeoJsonFeature[]>([]);
  const [coords, setCoords] = useState(initialPosition || { lat: 28.4595, lng: 77.0266 });

  const MAPTILER_API_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;

  const debounce = <F extends (...args: any[]) => any>(func: F, delay: number) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: Parameters<F>): void => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func(...args), delay);
    };
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchSuggestions = useCallback(
    debounce(async (query: string) => {
      if (query.length < 3 || !MAPTILER_API_KEY) {
        setSuggestions([]);
        return;
      }
      try {
        const response = await fetch(
          `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_API_KEY}&country=IN`
        );
        const data = await response.json();
        setSuggestions(data.features || []);
      } catch (error) {
        console.error('Error fetching geocoding suggestions:', error);
      }
    }, 300),
    [MAPTILER_API_KEY]
  );

  useEffect(() => {
    fetchSuggestions(searchQuery);
  }, [searchQuery, fetchSuggestions]);

  useEffect(() => {
    if (mapRef.current || !mapContainer.current || !MAPTILER_API_KEY) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`,
      center: [coords.lng, coords.lat],
      zoom: 12,
    });

    markerRef.current = new Marker({ draggable: true, color: '#d0291f' })
      .setLngLat([coords.lng, coords.lat])
      .addTo(mapRef.current);
    
    // Initial call to set coordinates on parent
    onLocationChange(coords.lat, coords.lng);

    const onDragEnd = () => {
      if (markerRef.current) {
        const lngLat = markerRef.current.getLngLat();
        onLocationChange(lngLat.lat, lngLat.lng);
        setCoords({ lat: lngLat.lat, lng: lngLat.lng });
      }
    };

    markerRef.current.on('dragend', onDragEnd);

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [MAPTILER_API_KEY]);

  const handleSuggestionClick = (feature: GeoJsonFeature) => {
    const [lng, lat] = feature.center;
    setCoords({ lat, lng });
    onLocationChange(lat, lng);

    mapRef.current?.flyTo({ center: [lng, lat], zoom: 14 });
    markerRef.current?.setLngLat([lng, lat]);
    setSearchQuery(feature.place_name);
    setSuggestions([]);
  };

  return (
    <div className="space-y-4 border p-4 rounded-lg bg-gray-50">
      <div>
        <label htmlFor="address-search" className="block text-sm font-medium text-gray-700">
          Search for an address
        </label>
        <div className="relative">
          <input
            id="address-search"
            type="text"
            placeholder="Start typing an address or city..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="mt-1 w-full border border-gray-300 p-3 rounded-md shadow-sm"
            autoComplete="off"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-10 w-full bg-white border border-gray-300 rounded-md mt-1 max-h-60 overflow-y-auto shadow-lg">
              {suggestions.map((suggestion, index) => (
                <li
                  key={index}
                  onClick={() => handleSuggestionClick(suggestion)}
                  className="px-4 py-2 cursor-pointer hover:bg-gray-100"
                >
                  {suggestion.place_name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      
      <p className="text-sm text-gray-600 flex items-center gap-2">
        <FaMapMarkerAlt className="text-red-500"/>
        <span>Drag the pin on the map to fine-tune the exact location.</span>
      </p>

      <div ref={mapContainer} className="w-full h-64 rounded-lg border" />
    </div>
  );
};

export default LocationPicker;
