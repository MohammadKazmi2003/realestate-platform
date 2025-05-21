// src/app/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Header from '@/app/components/Header'

type Property = {
  id: string
  title: string
  location: string
  price: number
  area_sqft: number
}

export default function Home() {
  const [properties, setProperties] = useState<Property[]>([])

  useEffect(() => {
    const fetchProperties = async () => {
      const { data, error } = await supabase.from('properties').select('*')
      if (!error && data) {
        setProperties(data)
      }
    }
    fetchProperties()
  }, [])

  return (
    <>
      <Header />
      <main className="p-6">
        <h1 className="text-2xl font-bold mb-4">All Properties</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {properties.map((property) => (
            <div key={property.id} className="border p-4 rounded shadow-sm">
              <h2 className="text-xl font-semibold">{property.title}</h2>
              <p>{property.location}</p>
              <p>₹{property.price.toLocaleString()}</p>
              <p>{property.area_sqft} sqft</p>
            </div>
          ))}
        </div>
      </main>
    </>
  )
}
