// src/app/favorites/page.tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link'; // Import Link for navigation
import { supabase } from '@/lib/supabaseClient'; // Import your browser Supabase client
import { useAuth } from '@/context/AuthContext'; // Import your AuthContext hook
import Header from '@/app/components/Header'; // Import the Header component
import { withAuth } from '@/utils/withAuth'; // Import the withAuth HOC for route protection

// Define a type for the property data you expect to display on this page.
// This should match the columns you select from your 'properties' table for a list view.
type Property = {
  id: string;
  title: string | null;
  location_text: string | null;
  price: number | null;
  area_sqft: number | null; // Ensure this matches your database column name (area_sqft or area)
  // Add other fields you might want to display on the card, e.g., a primary_image_url if available
};

/**
 * FavoritesPage component displays a list of properties that the logged-in user has favorited.
 * It fetches favorite property IDs from 'user_favorites' and then fetches the details of those properties.
 */
function FavoritesPage() {
  const { user } = useAuth(); // Get the current authenticated user
  const [favoriteProperties, setFavoriteProperties] = useState<Property[]>([]); // State to store favorited properties
  const [loading, setLoading] = useState<boolean>(true); // Loading state for data fetching
  const [error, setError] = useState<string | null>(null); // Error state for any issues during fetch

  // useEffect hook to fetch favorite properties when the component mounts or user changes
  useEffect(() => {
    // If no user is logged in, stop loading and return.
    // The withAuth HOC should ideally prevent unauthenticated access, but this is a safeguard.
    if (!user) {
      setLoading(false);
      return;
    }

    const fetchFavoriteProperties = async () => {
      setLoading(true); // Start loading
      setError(null);    // Clear any previous errors

      try {
        // 1. Fetch the IDs of the properties that the current user has favorited
        const { data: favoriteIdsData, error: favoriteIdsError } = await supabase
          .from('user_favorites')
          .select('property_id') // We only need the property_id from this table
          .eq('user_id', user.id); // Filter by the current user's ID

        if (favoriteIdsError) {
          // If there's an error fetching favorite IDs, throw it to be caught below
          throw favoriteIdsError;
        }

        // If no favorite IDs are found, set an empty array and stop loading
        if (!favoriteIdsData || favoriteIdsData.length === 0) {
          setFavoriteProperties([]);
          setLoading(false);
          return;
        }

        // Extract just the property IDs into an array
        const propertyIds = favoriteIdsData.map(fav => fav.property_id);

        // 2. Fetch the detailed information for each of the favorited properties
        // We use .in() to fetch multiple properties by their IDs efficiently
        const { data: propertiesData, error: propertiesError } = await supabase
          .from('properties')
          // Select the fields relevant for displaying in a list/card format
          .select('id, title, location_text, price, area_sqft')
          .in('id', propertyIds); // Fetch properties whose IDs are in our propertyIds array

        if (propertiesError) {
          // If there's an error fetching property details, throw it
          throw propertiesError;
        }

        // Set the fetched properties to state
        setFavoriteProperties(propertiesData || []);

      } catch (err) {
        // Catch any errors from either Supabase call and set the error message
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Error fetching favorite properties:", errorMessage);
        setError("Could not load your favorite properties. Please try again.");
        setFavoriteProperties([]); // Clear properties on error
      } finally {
        setLoading(false); // End loading, regardless of success or failure
      }
    };

    fetchFavoriteProperties(); // Call the fetch function
  }, [user]); // Re-run this effect whenever the 'user' object changes (e.g., on login/logout)

  return (
    <>
      <Header /> {/* Render the common Header component */}
      <main className="p-6 max-w-6xl mx-auto"> {/* Main content area with padding and max-width */}
        <h1 className="text-3xl font-bold mb-6 text-gray-800">My Favorite Properties</h1>

        {/* Conditional rendering based on loading, error, and data presence */}
        {loading && (
          <p className="text-lg text-gray-600 text-center py-10">Loading your favorite properties...</p>
        )}

        {error && (
          <p className="text-lg text-red-600 text-center py-10">{error}</p>
        )}

        {!loading && !error && favoriteProperties.length === 0 && (
          <p className="text-lg text-gray-600 text-center py-10">You haven't favorited any properties yet.</p>
        )}

        {!loading && !error && favoriteProperties.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {favoriteProperties.map((property) => (
              // Use Next.js Link component for client-side navigation
              // No 'legacyBehavior' needed with modern Next.js Link usage
              <Link href={`/property/${property.id}`} key={property.id} passHref>
                {/* The `<a>` tag is now a direct child of Link, and 'passHref' ensures it gets the href */}
                <div className="block border p-4 rounded-lg shadow-sm hover:shadow-lg transition-shadow duration-200 ease-in-out cursor-pointer">
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
                  <span className="text-indigo-600 hover:text-indigo-800 font-medium">
                    View Details &rarr;
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

// Wrap the FavoritesPage component with the withAuth HOC to protect the route.
// This ensures that only authenticated users can access this page.
export default withAuth(FavoritesPage);
