'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';
import { Loader2, Edit, Trash2, PlusSquare } from 'lucide-react';
import { PropertyCard, PropertyCardProps } from '@/app/components/PropertyCard';

function MyListingsPage() {
  const { user, loading: authLoading } = useAuth();
  const [myProperties, setMyProperties] = useState<PropertyCardProps['property'][]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }

    const fetchMyProperties = async () => {
      setLoading(true);
      setError(null);
      try {
        // This RPC call now points to our new, working function
        const { data, error: fetchError } = await supabase
          .rpc('get_user_listings_with_all_images', { p_user_id: user.id });

        if (fetchError) {
          throw fetchError;
        }
        
        setMyProperties((data as PropertyCardProps['property'][]) || []);
      } catch (err: any) {
        console.error("Error fetching my properties:", err);
        setError(`Failed to load listings: ${err.message || 'An unknown error occurred'}.`);
        setMyProperties([]);
      } finally {
        setLoading(false);
      }
    };

    fetchMyProperties();
  }, [user, authLoading]);

  const handleDeleteProperty = async (propertyId: string) => {
    if (!confirm('Are you sure you want to delete this property? This action cannot be undone.')) {
      return;
    }
    setDeletingId(propertyId);
    setError(null);
    try {
      // Deletion logic can remain the same, as RLS protects it.
      const { error: deletePropertyError } = await supabase
        .from('properties')
        .delete()
        .eq('id', propertyId)
        .eq('user_id', user?.id);

      if (deletePropertyError) throw deletePropertyError;
      setMyProperties(prevProperties => prevProperties.filter(p => p.id !== propertyId));
    } catch (err: any) {
      console.error("Error deleting property:", err);
      setError(`Failed to delete property: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">My Listings</h1>

        {(authLoading || loading) && (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="h-12 w-12 animate-spin text-text-color-light" />
          </div>
        )}

        {!loading && error && (
          <div className="text-lg text-center py-10 text-danger-color bg-red-100 p-4 rounded-2xl"><p className="font-semibold">Error</p><p className="text-sm mt-1">{error}</p></div>
        )}

        {!authLoading && !loading && !error && myProperties.length === 0 && (
          <div className="text-center py-20 shadow-neumorphic-outset rounded-3xl p-8">
            <PlusSquare className="mx-auto h-16 w-16 text-text-color-light" />
            <p className="mt-4 text-lg text-text-color-light">You have not listed any properties yet.</p>
            <Link href="/add-property" className="mt-6 inline-block neumorphic-button bg-cta-gradient">
              Add Your First Property
            </Link>
          </div>
        )}

        {!authLoading && !loading && !error && myProperties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {myProperties.map((property) => (
              <PropertyCard 
                key={property.id} 
                property={property}
                actions={
                  <>
                    <Link href={`/edit-property/${property.id}`} className="neumorphic-button flex-1 flex items-center justify-center gap-2">
                      <Edit size={16} /> Edit
                    </Link>
                    <button
                      onClick={() => handleDeleteProperty(property.id)}
                      disabled={deletingId === property.id}
                      className="neumorphic-button !bg-danger-color !text-white flex-1 flex items-center justify-center gap-2"
                    >
                      {deletingId === property.id ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
                      {deletingId === property.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default withAuth(MyListingsPage);
