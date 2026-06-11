'use client'

import { useEffect, useState } from 'react'
import Header from '@/app/components/Header'
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard'
import { Loader2 } from 'lucide-react'
import { searchProperties, mapEsResultToPropertyCard } from '@/lib/searchClient'

type PropertyWithImages = PropertyCardProps['property'];

export default function Home() {
  const [properties, setProperties] = useState<PropertyWithImages[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchProperties = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await searchProperties({ pageSize: 12, sort: 'newest' });
        if (!response || !response.results) {
          setError('Failed to load featured properties.');
          setProperties([]);
        } else {
          const mapped = response.results.map((r: any) => mapEsResultToPropertyCard(r));
          setProperties(mapped);
        }
      } catch (err) {
        console.error('Error fetching properties:', err);
        setError('Failed to load featured properties.');
        setProperties([]);
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
        {error && <div className="text-lg text-danger-color text-center py-10 bg-red-100 rounded-2xl p-4"><p className="font-semibold">Error</p><p className="text-sm mt-1">{error}</p></div>}
        
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
