'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { Marker } from 'maplibre-gl';
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { FaSpinner } from 'react-icons/fa';

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
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const markerInstance = useRef<Marker | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<GeoJsonFeature[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  
  const MAPTILER_API_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;

  const debounce = useCallback(<F extends (...args: any[]) => any>(func: F, delay: number) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: Parameters<F>): void => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func(...args), delay);
    };
  }, []);

  const fetchSuggestions = useCallback(
    debounce(async (query: string) => {
      if (query.length < 3 || !MAPTILER_API_KEY) {
        setSuggestions([]);
        setIsSearching(false);
        return;
      }
      try {
        const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_API_KEY}&country=IN`);
        const data = await response.json();
        setSuggestions(data.features || []);
      } catch (error) {
        console.error('Error fetching geocoding suggestions:', error);
      } finally {
        setIsSearching(false);
      }
    }, 500),
    [MAPTILER_API_KEY, debounce]
  );

  useEffect(() => {
    if (searchQuery) {
      setIsSearching(true);
      fetchSuggestions(searchQuery);
    } else {
      setIsSearching(false);
      setSuggestions([]);
    }
  }, [searchQuery, fetchSuggestions]);

  useEffect(() => {
    const mapNode = mapContainer.current;

    if (!mapNode) return;
    if (!MAPTILER_API_KEY) {
      setMapError("Map API Key is missing. Please check your .env.local file.");
      setIsLoading(false);
      return;
    }
    
    const resizeObserver = new ResizeObserver(() => {
      if (!mapInstance.current && mapNode.clientWidth > 0 && mapNode.clientHeight > 0) {
        
        resizeObserver.disconnect();
        
        const center: [number, number] = [initialPosition?.lng || 77.0266, initialPosition?.lat || 28.4595];
        
        try {
          const map = new maplibregl.Map({
            container: mapNode,
            style: `https://api.maptiler.com/maps/basic-v2/style.json?key=${MAPTILER_API_KEY}`,
            center: center,
            zoom: 12,
          });
          mapInstance.current = map;

          map.on('load', () => {
            if (!mapInstance.current) return;
            
            markerInstance.current = new Marker({ color: '#d0291f', draggable: true })
              .setLngLat(center)
              .addTo(map);
            
            onLocationChange(center[1], center[0]);

            markerInstance.current.on('dragend', () => {
              const { lng, lat } = markerInstance.current!.getLngLat();
              onLocationChange(lat, lng);
            });

            map.on('click', (e) => {
              const { lng, lat } = e.lngLat;
              if (markerInstance.current) {
                markerInstance.current.setLngLat([lng, lat]);
              }
              onLocationChange(lat, lng);
            });
            
            setIsLoading(false);
            
            setTimeout(() => mapInstance.current?.resize(), 0);
          });

          map.on('error', (e) => {
            console.error('A MapLibre GL error occurred:', e.error);
            setMapError(`Map failed to load. Please check API key and network.`);
            setIsLoading(false);
          });

        } catch (error: any) {
          console.error("Failed to initialize map:", error);
          setMapError("An unexpected error occurred during map initialization.");
          setIsLoading(false);
        }
      }
    });

    resizeObserver.observe(mapNode);

    return () => {
      resizeObserver.disconnect();
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
  }, []); 

  const handleSuggestionClick = (feature: GeoJsonFeature) => {
    const [lng, lat] = feature.center;
    const readableName = feature.place_name.split(',')[0];
    onLocationChange(lat, lng);
    if(mapInstance.current) {
      mapInstance.current.flyTo({ center: [lng, lat], zoom: 14 });
    }
    if (markerInstance.current) {
      markerInstance.current.setLngLat([lng, lat]);
    }
    setSearchQuery(readableName);
    setSuggestions([]);
  };

  return (
    <div className="space-y-4 shadow-neumorphic-outset p-4 rounded-3xl bg-bg-color">
      <div>
        <label htmlFor="address-search" className="block text-sm font-medium text-text-color-light">Search for an address or click/drag the pin</label>
        <div className="relative mt-1">
          <input
            id="address-search"
            type="text"
            placeholder="Start typing..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setTimeout(() => setIsFocused(false), 200)}
            className="neumorphic-input"
            autoComplete="off"
          />
          {isSearching && <FaSpinner className="animate-spin absolute right-3 top-1/2 -translate-y-1/2 text-text-color-light"/>}
          
          {isFocused && suggestions.length > 0 && (
            <ul className="absolute z-50 w-full bg-bg-color shadow-neumorphic-outset rounded-2xl mt-2 max-h-60 overflow-y-auto">
              {suggestions.map((suggestion) => (
                <li
                  key={suggestion.place_name + Math.random()}
                  onMouseDown={() => handleSuggestionClick(suggestion)}
                  className="px-4 py-2 cursor-pointer hover:bg-shadow-dark/20 text-text-color-dark"
                >
                  {suggestion.place_name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      
      {/* Restoring the original classes for the Neumorphic design */}
      <div className="relative w-full h-72 rounded-2xl shadow-neumorphic-inset overflow-hidden">
        {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg-color/50 z-20">
                <FaSpinner className="animate-spin text-2xl text-text-color-light" />
                <span className="ml-2 text-text-color-light">Initializing Map...</span>
            </div>
        )}
        {mapError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-500/10 z-20 text-red-500 text-center p-4 rounded-2xl">
                <p className='font-semibold'>Map Error</p>
                <p className='text-sm'>{mapError}</p>
            </div>
        )}
        
        <div ref={mapContainer} className="absolute inset-0" />
      </div>
    </div>
  );
};

export default LocationPicker;