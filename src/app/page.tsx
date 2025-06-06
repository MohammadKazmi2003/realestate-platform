// src/app/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Header from '@/app/components/Header'
import Link from 'next/link'
import { WhatsAppButton } from '@/app/components/WhatsAppButton'

// This type now correctly matches the RPC function's return columns
type Property = {
  id: string
  title: string
  location_text: string
  price: number
  area_sqft: number
  owner_phone: string | null
  user_id: string; // The property owner's user ID
}

export default function Home() {
  const [properties, setProperties] = useState<Property[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchProperties = async () => {
      setLoading(true);
      setError(null);
      
      // --- CORRECTED: Calling the new, correct function name for the home page ---
      const { data, error: rpcError } = await supabase.rpc('get_featured_properties');

      if (rpcError) {
        console.error('Error fetching featured properties:', rpcError);
        setError(`Failed to load properties: ${rpcError.message}`);
        setProperties([]);
      } else if (data) {
        setProperties(data);
      }
      setLoading(false);
    }
    fetchProperties();
  }, []);

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
              <div key={property.id} className="border p-4 rounded-lg shadow-sm hover:shadow-lg transition-shadow duration-200 ease-in-out flex flex-col justify-between">
                <Link href={`/property/${property.id}`} className="flex flex-col flex-grow">
                    <div className="flex-grow">
                        <h2 className="text-xl font-semibold mb-1 truncate" title={property.title}>{property.title}</h2>
                        <p className="text-gray-700 mb-1 truncate" title={property.location_text || undefined}>{property.location_text || 'Location not specified'}</p>
                        <p className="text-green-600 font-semibold mb-1">₹{property.price?.toLocaleString() || 'N/A'}</p>
                        <p className="text-sm text-gray-600 mb-3">{property.area_sqft} sqft</p>
                    </div>
                    <div className="flex justify-between items-center mt-4">
                        <span className="text-indigo-600 hover:text-indigo-800 font-medium">
                          View Details &rarr;
                        </span>
                    </div>
                </Link>
                {property.owner_phone && (
                  <div className="mt-2">
                    <WhatsAppButton 
                      phoneNumber={property.owner_phone}
                      propertyTitle={property.title}
                      propertyId={property.id} 
                      ownerId={property.user_id} 
                      className="w-full"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
