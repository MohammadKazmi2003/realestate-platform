'use client'

import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

export default function MapView({ coordinates }: { coordinates: [number, number] }) {
  const mapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!mapRef.current || !coordinates) return

    const [lng, lat] = coordinates
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [lng, lat],
      zoom: 13,
    })

    new maplibregl.Marker().setLngLat([lng, lat]).addTo(map)

    return () => map.remove()
  }, [coordinates])

  return <div ref={mapRef} className="w-full h-64 rounded-lg shadow-md" />
}
