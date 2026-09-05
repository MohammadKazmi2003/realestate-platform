'use client'

import 'maplibre-gl/dist/maplibre-gl.css'
import maplibregl from 'maplibre-gl'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { searchProperties } from '@/lib/searchClient'
import { tenant } from '@/lib/tenant'

const DEFAULT_CENTER = { lat: tenant.map.center[1], lng: tenant.map.center[0] }
const GEOLOCATION_TIMEOUT = 10000

export default function MapPage() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const circleRef = useRef<maplibregl.GeoJSONSource | null>(null)
  const centerMarkerRef = useRef<maplibregl.Marker | null>(null)
  const router = useRouter()
  const [radius, setRadius] = useState<number>(2)
  const [centerCoords, setCenterCoords] = useState<{ lat: number; lng: number }>(DEFAULT_CENTER)
  const [userLocationAvailable, setUserLocationAvailable] = useState<boolean>(false)
  const [locationLoading, setLocationLoading] = useState<boolean>(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  const fetchProperties = useCallback(async (selectedLat: number, selectedLng: number, selectedRadius: number) => {
    try {
      const response = await searchProperties({
        lat: selectedLat,
        lng: selectedLng,
        radiusKm: selectedRadius,
        pageSize: 100,
        sort: 'newest',
      });
      if (!response || !response.results) {
        console.error('Search returned no data');
        return [];
      }
      return response.results.map((r: any) => {
        const loc = r.location || {};
        return {
          id: r.id,
          title: r.title || '',
          latitude: loc.lat || r.latitude || null,
          longitude: loc.lon || r.longitude || null,
        };
      });
    } catch (err) {
      console.error('Error fetching properties:', err);
      return [];
    }
  }, [])

  const clearMarkers = useCallback(() => {
    markersRef.current.forEach((marker) => marker.remove())
    markersRef.current = []
    if (mapRef.current) {
      ['properties-cluster', 'properties-cluster-count', 'properties-unclustered'].forEach(l => {
        if (mapRef.current.getLayer(l)) mapRef.current.removeLayer(l)
      })
      if (mapRef.current.getSource('properties')) mapRef.current.removeSource('properties')
    }
  }, [])

  const addClusteredMarkers = useCallback((properties: any[], map: maplibregl.Map) => {
    if (properties.length === 0) return

    const features = properties
      .filter(p => p.latitude && p.longitude)
      .map(p => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.longitude, p.latitude] },
        properties: { id: p.id, title: p.title },
      }))

    if (features.length === 0) return

    map.addSource('properties', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
      cluster: true,
      clusterMaxZoom: 14,
      clusterRadius: 50,
    })

    map.addLayer({
      id: 'properties-cluster',
      type: 'circle',
      source: 'properties',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#3B82F6', 10, '#2563EB', 50, '#1D4ED8'],
        'circle-radius': ['step', ['get', 'point_count'], 20, 10, 30, 50, 40],
        'circle-opacity': 0.8,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    })

    map.addLayer({
      id: 'properties-cluster-count',
      type: 'symbol',
      source: 'properties',
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-size': 12,
      },
      paint: { 'text-color': '#ffffff' },
    })

    map.addLayer({
      id: 'properties-unclustered',
      type: 'circle',
      source: 'properties',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': '#3B82F6',
        'circle-radius': 8,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
      },
    })

    map.on('click', 'properties-cluster', (e) => {
      const feature = e.features?.[0]
      if (!feature) return
      const clusterId = feature.properties?.cluster_id
      const source = map.getSource('properties') as maplibregl.GeoJSONSource
      source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || zoom == null) return
        map.flyTo({ center: (feature.geometry as any).coordinates as [number, number], zoom: zoom + 1 })
      })
    })

    map.on('click', 'properties-unclustered', (e) => {
      const feature = e.features?.[0]
      if (feature?.properties?.id) {
        router.push(`/property/${feature.properties.id}`)
      }
    })

    map.on('mouseenter', ['properties-cluster', 'properties-unclustered'], () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', ['properties-cluster', 'properties-unclustered'], () => {
      map.getCanvas().style.cursor = ''
    })
  }, [router])

  const drawCircle = useCallback((center: { lat: number; lng: number }, radiusInKm: number) => {
    if (!mapRef.current || !mapRef.current.isStyleLoaded()) return

    const R = 6371
    const points: [number, number][] = []
    const numSides = 64
    const centerLat = center.lat * Math.PI / 180
    const centerLng = center.lng * Math.PI / 180
    const d = radiusInKm / R

    for (let i = 0; i <= numSides; i++) {
      const angle = (i * 2 * Math.PI) / numSides
      const lat = Math.asin(Math.sin(centerLat) * Math.cos(d) + Math.cos(centerLat) * Math.sin(d) * Math.cos(angle))
      const lng = centerLng + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(centerLat), Math.cos(d) - Math.sin(centerLat) * Math.sin(lat))
      points.push([lng * 180 / Math.PI, lat * 180 / Math.PI])
    }

    const circleGeoJSON = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [points] }, properties: {} }],
    }

    if (circleRef.current) {
      circleRef.current.setData(circleGeoJSON)
    } else {
      mapRef.current.addSource('radius-circle', { type: 'geojson', data: circleGeoJSON })
      circleRef.current = mapRef.current.getSource('radius-circle') as maplibregl.GeoJSONSource
      mapRef.current.addLayer({
        id: 'radius-circle-layer',
        type: 'fill',
        source: 'radius-circle',
        paint: { 'fill-color': '#00aaff', 'fill-opacity': 0.2 },
      })
    }
  }, [])

  const addCenterMarker = useCallback((center: { lat: number; lng: number }) => {
    if (!mapRef.current) return
    if (centerMarkerRef.current) {
      centerMarkerRef.current.setLngLat([center.lng, center.lat])
    } else {
      centerMarkerRef.current = new maplibregl.Marker({ color: 'red' })
        .setLngLat([center.lng, center.lat])
        .addTo(mapRef.current)
    }
  }, [])

  const updateMap = useCallback(async (newCenter: { lat: number; lng: number }, newRadius: number) => {
    if (mapRef.current && mapRef.current.isStyleLoaded()) {
      await mapRef.current.flyTo({ center: [newCenter.lng, newCenter.lat], zoom: Math.max(9, mapRef.current.getZoom()), essential: true })
      const properties = await fetchProperties(newCenter.lat, newCenter.lng, newRadius)
      clearMarkers()
      addClusteredMarkers(properties, mapRef.current)
      drawCircle(newCenter, newRadius)
      addCenterMarker(newCenter)
    }
  }, [fetchProperties, clearMarkers, addClusteredMarkers, drawCircle, addCenterMarker])

  const initMap = useCallback(() => {
    mapRef.current = new maplibregl.Map({
      container: mapContainer.current!,
      style: `https://api.maptiler.com/maps/bright/style.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`,
      center: [centerCoords.lng, centerCoords.lat],
      zoom: 10,
    })

    mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right')

    mapRef.current.on('load', async () => {
      const properties = await fetchProperties(centerCoords.lat, centerCoords.lng, radius)
      clearMarkers()
      addClusteredMarkers(properties, mapRef.current!)
      drawCircle(centerCoords, radius)
      addCenterMarker(centerCoords)
    })

    mapRef.current.on('click', (e) => {
      const newCenter = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      setCenterCoords(newCenter)
      updateMap(newCenter, radius)
    })

    if (!navigator.geolocation) {
      console.log('Geolocation is not supported by your browser.')
      setLocationError('Geolocation not supported.')
      setLocationLoading(false)
      return
    }

    setLocationLoading(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userCenter = { lat: position.coords.latitude, lng: position.coords.longitude }
        setCenterCoords(userCenter)
        setUserLocationAvailable(true)
        updateMap(userCenter, radius)
        setLocationLoading(false)
      },
      (error) => {
        console.error('Error getting initial location:', error)
        setLocationError(`Location error (${error.code}): ${error.message}`)
        setLocationLoading(false)
      },
      { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT, maximumAge: 0 }
    )
  }, [centerCoords, radius, fetchProperties, clearMarkers, addClusteredMarkers, drawCircle, addCenterMarker, updateMap])

  useEffect(() => {
    if (!mapRef.current) {
      initMap()
    }
  }, [initMap])

  const handleRadiusChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newRadius = Number(e.target.value)
    setRadius(newRadius)
    updateMap(centerCoords, newRadius)
  }

  const handleUseGeolocation = () => {
    if (navigator.geolocation) {
      setLocationLoading(true)
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const newCenter = { lat: position.coords.latitude, lng: position.coords.longitude }
          setCenterCoords(newCenter)
          setUserLocationAvailable(true)
          updateMap(newCenter, radius)
          setLocationLoading(false)
          setLocationError(null)
        },
        (error) => {
          console.error('Error getting location:', error)
          setLocationError(`Location error (${error.code}): ${error.message}`)
          setLocationLoading(false)
        },
        { enableHighAccuracy: true, timeout: GEOLOCATION_TIMEOUT, maximumAge: 0 }
      )
    } else {
      setLocationError('Geolocation not supported by your browser.')
    }
  }

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => { console.log('Basic Geolocation Success:', position.coords) },
        (error) => { console.error('Basic Geolocation Error:', error) }
      )
    }
  }, [])

  return (
    <div className="relative w-full h-screen">
      <div className="absolute z-10 top-4 left-4 bg-white rounded shadow p-2 flex flex-col gap-2">
        <div>
          <button
            onClick={handleUseGeolocation}
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm"
            disabled={locationLoading}
          >
            {locationLoading ? 'Locating...' : 'Use My Location'}
          </button>
          {locationError && <p className="text-xs text-red-500 mt-1">{locationError}</p>}
          {userLocationAvailable && <p className="text-xs text-green-500 mt-1">Location found!</p>}
          {!userLocationAvailable && !locationError && (centerCoords !== DEFAULT_CENTER) && (
            <p className="text-xs text-gray-600 mt-1">Showing properties around the detected location.</p>
          )}
          {!userLocationAvailable && !locationError && (centerCoords === DEFAULT_CENTER) && (
            <p className="text-xs text-gray-600 mt-1">Showing properties around Gurgaon (default).</p>
          )}
        </div>
        <div>
          <label htmlFor="radiusSlider" className="block text-sm font-medium mb-1">
            Radius: {radius} km
          </label>
          <input
            type="range"
            id="radiusSlider"
            min="1"
            max="20"
            value={radius}
            onChange={handleRadiusChange}
            className="w-full"
          />
        </div>
      </div>
      <div ref={mapContainer} className="w-full h-full" />
    </div>
  )
}
