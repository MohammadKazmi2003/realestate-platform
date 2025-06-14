'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import { Loader2, HeartCrack } from 'lucide-react';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';

function FavoritesPage() {
  const { user } = useAuth();
  const [favoriteProperties, setFavoriteProperties] = useState<PropertyCardProps['property'][]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    const fetchFavoriteProperties = async () => {
      setLoading(true);
      setError(null);

      try {
        const { data, error: fetchError } = await supabase
          .rpc('get_user_favorites_with_all_images', { p_user_id: user.id });

        if (fetchError) throw fetchError;

        setFavoriteProperties((data as PropertyCardProps['property'][]) || []);
      } catch (err: any) {
        // **CORRECTED ERROR HANDLING**
        console.error("Error fetching favorite properties:", err);
        setError(`Could not load your favorites: ${err.message || 'An unknown error occurred'}. Please ensure the database function 'get_user_favorites_with_all_images' exists.`);
        setFavoriteProperties([]);
      } finally {
        setLoading(false);
      }
    };

    fetchFavoriteProperties();
  }, [user]);

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">My Favorite Properties</h1>

        {loading && (
           <div className="flex justify-center items-center py-20">
             <Loader2 className="h-12 w-12 animate-spin text-text-color-light" />
           </div>
        )}
        {error && (
          <div className="text-lg text-center py-10 text-danger-color bg-red-100 p-4 rounded-2xl"><p className="font-semibold">Database Error</p><p className="text-sm mt-1">{error}</p></div>
        )}
        {!loading && !error && favoriteProperties.length === 0 && (
          <div className="text-center py-20 shadow-neumorphic-outset rounded-3xl p-8">
            <HeartCrack className="mx-auto h-16 w-16 text-text-color-light" />
            <p className="mt-4 text-lg text-text-color-light">You haven't favorited any properties yet.</p>
            <Link href="/browse" className="mt-6 inline-block neumorphic-button bg-cta-gradient">
              Browse Properties
            </Link>
          </div>
        )}
        {!loading && !error && favoriteProperties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
            {favoriteProperties.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default withAuth(FavoritesPage);
