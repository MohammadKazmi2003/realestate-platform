// src/app/my-listings/page.tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import Header from '@/app/components/Header';
import { withAuth } from '@/utils/withAuth';

// Define a type for the property data to display
type MyListingProperty = {
  id: string;
  title: string | null;
  location_text: string | null;
  price: number | null;
  area_sqft: number | null;
  // You might want to add other fields like created_at or image_url later
};

/**
 * MyListingsPage component displays a list of properties owned by the currently authenticated user,
 * with an option to delete them.
 */
function MyListingsPage() {
  const { user, loading: authLoading } = useAuth(); // Get user and auth loading state
  const [myProperties, setMyProperties] = useState<MyListingProperty[]>([]);
  const [loading, setLoading] = useState<boolean>(true); // For data fetching
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null); // To track which property is being deleted

  // Effect to fetch properties owned by the logged-in user
  useEffect(() => {
    // Wait until auth state is not loading and user is available
    if (authLoading || !user) {
      if (!user && !authLoading) { // If not loading and no user, it means user is not authenticated
        // Redirection handled by withAuth HOC
      }
      return;
    }

    const fetchMyProperties = async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: fetchError } = await supabase
          .from('properties')
          .select('id, title, location_text, price, area_sqft')
          .eq('user_id', user.id); // Crucially, filter by the current user's ID

        if (fetchError) {
          throw fetchError;
        }
        setMyProperties(data || []);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Error fetching my properties:", errorMessage);
        setError("Could not load your listings.");
        setMyProperties([]);
      } finally {
        setLoading(false);
      }
    };

    fetchMyProperties();
  }, [user, authLoading]); // Re-fetch when user or authLoading state changes

  // Handler for deleting a property
  const handleDeleteProperty = async (propertyId: string) => {
    // IMPORTANT: For a production app, replace `confirm` with a custom modal UI.
    if (!confirm('Are you sure you want to delete this property? This action cannot be undone.')) {
      return; // User cancelled
    }

    setDeletingId(propertyId); // Set the ID of the property currently being deleted
    setError(null); // Clear any previous errors

    try {
      // --- START: Enhanced Image Deletion (Metadata + Storage) ---
      // 1. Fetch image URLs/paths associated with the property
      const { data: imagesData, error: fetchImagesError } = await supabase
        .from('property_images')
        .select('image_url')
        .eq('property_id', propertyId);

      if (fetchImagesError) {
        console.error("Error fetching image URLs for deletion:", fetchImagesError);
        // Do not throw, proceed with property deletion even if image URL fetch fails
      }

      if (imagesData && imagesData.length > 0) {
        const filePathsToDelete = imagesData.map(img => {
          // Extract the path from the full public URL
          // The new path structure is: <user-id>/<property-id>/<filename>
          // Example URL: "https://<project-id>.supabase.co/storage/v1/object/public/property-images/<user-id>/<property-id>/<filename>"
          const pathSegments = img.image_url?.split('property-images/');
          // We need the part after 'property-images/', which includes user_id/property_id/filename
          return pathSegments && pathSegments.length > 1 ? pathSegments[1] : null;
        }).filter(Boolean) as string[]; // Filter out nulls and assert type

        if (filePathsToDelete.length > 0) {
          // 2. Delete actual image files from Supabase Storage
          const { error: storageDeleteError } = await supabase.storage
            .from('property-images') // Your bucket name
            .remove(filePathsToDelete);

          if (storageDeleteError) {
            console.error("Error deleting images from storage:", storageDeleteError);
            // Do not throw, continue with database deletion
          }
        }
      }
      // --- END: Enhanced Image Deletion ---

      // Delete image metadata from property_images table (important for FK constraint)
      const { error: deleteImagesMetadataError } = await supabase
        .from('property_images')
        .delete()
        .eq('property_id', propertyId);

      if (deleteImagesMetadataError) {
        console.error("Error deleting image metadata:", deleteImagesMetadataError);
        // Do not throw here, continue to delete property even if image metadata fails
      }

      // Then, delete the property itself
      const { error: deletePropertyError } = await supabase
        .from('properties')
        .delete()
        .eq('id', propertyId)
        .eq('user_id', user?.id); // Double check user_id for security (RLS handles this but good client-side practice)

      if (deletePropertyError) {
        throw deletePropertyError;
      }

      // If successful, update the state to remove the deleted property from the list
      setMyProperties(prevProperties => prevProperties.filter(p => p.id !== propertyId));
      alert('Property deleted successfully!');

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error("Error deleting property:", errorMessage);
      setError(`Failed to delete property: ${errorMessage}`);
      alert(`Failed to delete property: ${errorMessage}`); // Provide feedback to user
    } finally {
      setDeletingId(null); // Clear deleting state
    }
  };

  return (
    <>
      <Header />
      <main className="p-6 max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-6 text-gray-800">My Listings</h1>

        {authLoading && ( // Show auth loading first
          <p className="text-lg text-gray-600 text-center py-10">Checking authentication...</p>
        )}

        {!authLoading && loading && ( // Then show data loading
          <p className="text-lg text-gray-600 text-center py-10">Loading your listings...</p>
        )}

        {!authLoading && !loading && error && (
          <p className="text-lg text-red-600 text-center py-10">{error}</p>
        )}

        {!authLoading && !loading && !error && myProperties.length === 0 && (
          <div className="text-center py-10">
            <p className="text-lg text-gray-600 mb-4">You have not listed any properties yet.</p>
            <Link href="/add-property" passHref>
              <span className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 cursor-pointer">
                Add Your First Property
              </span>
            </Link>
          </div>
        )}

        {!authLoading && !loading && !error && myProperties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {myProperties.map((property) => (
              <div key={property.id} className="border p-4 rounded-lg shadow-sm hover:shadow-lg transition-shadow duration-200 ease-in-out relative">
                <Link href={`/property/${property.id}`} passHref>
                  <div className="block cursor-pointer"> {/* This div acts as the clickable area for details */}
                    <h2 className="text-xl font-semibold mb-1 truncate" title={property.title || undefined}>
                      {property.title || 'N/A'}
                    </h2>
                    <p className="text-gray-700 mb-1 truncate" title={property.location_text || undefined}>
                      {property.location_text || 'Location not specified'}
                    </p>
                    <p className="text-green-600 font-semibold mb-1">
                      {property.price ? `₹${property.price.toLocaleString()}` : 'Price N/A'}
                    </p>
                    <p className="text-sm text-gray-600 mb-3">
                      {property.area_sqft ? `${property.area_sqft} sqft` : 'Area N/A'}
                    </p>
                  </div>
                </Link>
                {/* Action Buttons */}
                <div className="flex gap-2 mt-3">
                  {/* Edit Button */}
                  <Link href={`/edit-property/${property.id}`} passHref>
                    <span className="px-3 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm cursor-pointer">
                      Edit Listing
                    </span>
                  </Link>
                  {/* Delete Button */}
                  <button
                    onClick={() => handleDeleteProperty(property.id)}
                    disabled={deletingId === property.id} // Disable button if this property is being deleted
                    className="px-3 py-1 bg-red-500 text-white rounded-md hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                  >
                    {deletingId === property.id ? 'Deleting...' : 'Delete Listing'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

// Wrap the page with withAuth to protect it
export default withAuth(MyListingsPage);
