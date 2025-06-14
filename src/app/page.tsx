'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import Header from '@/app/components/Header'
import { PropertyCard } from '@/app/components/PropertyCard'
import { Loader2 } from 'lucide-react'

// This type now matches the output of our new SQL function
type PropertyWithImages = {
  id: string;
  title: string;
  location_text: string;
  price: number;
  area_sqft: number;
  owner_phone: string | null;
  user_id: string;
  images: { image_url: string }[];
}

export default function Home() {
  const [properties, setProperties] = useState<PropertyWithImages[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchProperties = async () => {
      setLoading(true);
      setError(null);
      
      // We call the function that gets ALL images now
      const { data, error: rpcError } = await supabase.rpc('get_properties_with_all_images');

      if (rpcError) {
        console.error('Error fetching properties:', rpcError);
        setError(`Failed to load properties. Make sure the database function 'get_properties_with_all_images' is created.`);
        setProperties([]);
      } else if (data) {
        setProperties(data as PropertyWithImages[]);
      }
      setLoading(false);
    }
    fetchProperties();
  }, []);

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">Featured Properties</h1>
        {loading && <div className="flex justify-center py-20"><Loader2 className="animate-spin h-12 w-12 text-text-color-light" /></div>}
        {error && <div className="text-lg text-danger-color text-center py-10 bg-red-100 rounded-2xl p-4"><p className="font-semibold">Database Error</p><p className="text-sm mt-1">{error}</p></div>}
        
        {!loading && !error && properties.length === 0 && (
          <p className="text-lg text-center py-10 text-text-color-light">No featured properties found. Check back soon!</p>
        )}

        {!loading && !error && properties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {properties.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
