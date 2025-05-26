// src/app/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient' //
import Header from '@/app/components/Header' //
import Link from 'next/link'; // Import Link

// Using your existing Property type
type Property = {
  id: string
  title: string
  location_text: string // This is what your type uses, ensure 'properties' table has 'location'
                  // If it's 'location_text' in the DB, you'd need to adjust here or the select
  price: number
  area_sqft: number
}

export default function Home() {
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(true); // Add loading state
  const [error, setError] = useState<string | null>(null); // Add error state

  useEffect(() => {
    const fetchProperties = async () => {
      setLoading(true);
      setError(null);
      // Using your existing select('*')
      const { data, error: fetchError } = await supabase
        .from('properties')
        .select('*') // This will fetch all columns
        .limit(10); // Added a limit as fetching all can be heavy

      if (fetchError) {
        console.error('Error fetching properties:', fetchError);
        setError(`Failed to load properties: ${fetchError.message}`);
        setProperties([]); // Clear properties on error
      } else if (data) {
        // Ensure the data matches the Property type.
        // If select('*') returns columns not in your Property type, they'll be ignored by TypeScript here.
        // If it's missing columns *expected* by Property type (e.g. if 'location' is actually 'location_text' in DB),
        // then `property.location` might be undefined later.
        setProperties(data as Property[]);
      }
      setLoading(false);
    }
    fetchProperties()
  }, [])

  return (
    <>
      <Header />
      <main className="p-6">
        <h1 className="text-2xl font-bold mb-4">Featured Properties</h1>
        {loading && <p className="text-lg text-gray-600 text-center py-10">Loading properties...</p>}
        {error && <p className="text-lg text-red-600 text-center py-10">{error}</p>}
        {!loading && !error && properties.length === 0 && (
          <p className="text-lg text-gray-600 text-center py-10">No properties found at the moment. Check back soon!</p>
        )}
        {!loading && !error && properties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {properties.map((property) => (
              <div key={property.id} className="border p-4 rounded-lg shadow-sm hover:shadow-lg transition-shadow duration-200 ease-in-out">
                <h2 className="text-xl font-semibold mb-1 truncate" title={property.title}>{property.title}</h2>
                {/*
                  Based on your schema, 'location_text' is the column name.
                  If your 'properties' table actually has a 'location' text column that select('*') picks up, this is fine.
                  If not, and you want to use 'location_text', your Property type and/or select should be adjusted.
                  For now, assuming 'location' exists as per your type.
                */}
                <p className="text-gray-700 mb-1 truncate" title={property.location}>{property.location || 'Location not specified'}</p>
                <p className="text-green-600 font-semibold mb-1">₹{property.price.toLocaleString()}</p>
                <p className="text-sm text-gray-600 mb-3">{property.area_sqft} sqft</p>
                <Link href={`/property/${property.id}`} className="text-indigo-600 hover:text-indigo-800 font-medium">
                  View Details &rarr;
                </Link>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  )
}