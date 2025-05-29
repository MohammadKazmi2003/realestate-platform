// src/app/property/[id]/PropertyDetailsClient.tsx
'use client';

import { useEffect, useState } from 'react';
import type { FlattenedProperty, ImageType } from './page'; // Ensure correct path
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel'; // Ensure this path is correct

// Add these imports:
import { supabase } from '@/lib/supabaseClient'; // Import your browser Supabase client
import { useAuth } from '@/context/AuthContext'; // Import your AuthContext hook
import { useRouter } from 'next/navigation'; // Import useRouter for redirection

type Props = {
  property: FlattenedProperty | null;
  images: ImageType[];
};

export default function PropertyDetailClient({ property, images }: Props) {
  const [displayDate, setDisplayDate] = useState<string>('');
  const { user } = useAuth(); // Get current user from AuthContext
  const router = useRouter(); // For redirecting if the user needs to sign in

  // State for favorite status and loading
  const [isFavorited, setIsFavorited] = useState<boolean>(false);
  const [isFavoriteLoading, setIsFavoriteLoading] = useState<boolean>(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  // Effect to format the property creation date
  useEffect(() => {
    if (property?.created_at) {
      setDisplayDate(new Date(property.created_at).toLocaleDateString());
    }
  }, [property?.created_at]);

  // Effect to check if the property is favorited by the current user
  useEffect(() => {
    // Only proceed if a user is logged in and property ID is available
    if (!user || !property?.id) {
      setIsFavorited(false); // Reset favorite status if no user or property
      return;
    }

    const checkFavoriteStatus = async () => {
      setIsFavoriteLoading(true); // Set loading true while checking
      setFavoriteError(null); // Clear any previous errors

      try {
        // Query the user_favorites table for a record matching the current user and property
        const { data, error } = await supabase
          .from('user_favorites')
          .select('*') // Select all columns, we just need to know if a record exists
          .eq('user_id', user.id) // Filter by current user's ID
          .eq('property_id', property.id) // Filter by current property's ID
          .maybeSingle(); // Use maybeSingle to get one record or null if not found

        if (error) {
          console.error("Error checking favorite status:", error);
          setFavoriteError("Could not check favorite status.");
          setIsFavorited(false); // Assume not favorited on error
        } else {
          // If data exists, it means the property is favorited
          setIsFavorited(!!data);
        }
      } catch (err) {
        console.error("Unexpected error checking favorite status:", err);
        setFavoriteError("An unexpected error occurred.");
        setIsFavorited(false);
      } finally {
        setIsFavoriteLoading(false); // Set loading false when check is complete
      }
    };

    checkFavoriteStatus();
  }, [user, property?.id]); // Re-run this effect when user or property ID changes

  // Function to toggle favorite status (add or remove)
  const handleToggleFavorite = async () => {
    // If no user is logged in, prompt them to sign in
    if (!user) {
      // Using a simple alert for now, consider a more user-friendly modal
      alert("Please sign in to favorite properties.");
      router.push('/sign-in'); // Redirect to sign-in page
      return;
    }
    // If property ID is missing, prevent action
    if (!property?.id) {
      setFavoriteError("Property ID is missing. Cannot favorite.");
      return;
    }

    setIsFavoriteLoading(true); // Set loading true during the toggle operation
    setFavoriteError(null); // Clear previous errors

    try {
      if (isFavorited) {
        // If currently favorited, remove it
        const { error } = await supabase
          .from('user_favorites')
          .delete()
          .eq('user_id', user.id)
          .eq('property_id', property.id);

        if (error) {
          console.error("Error removing favorite:", error);
          setFavoriteError("Could not remove favorite.");
        } else {
          setIsFavorited(false); // Update state to unfavorited
        }
      } else {
        // If not favorited, add it
        const { error } = await supabase
          .from('user_favorites')
          .insert({ user_id: user.id, property_id: property.id });

        if (error) {
          console.error("Error adding favorite:", error);
          setFavoriteError("Could not add favorite.");
        } else {
          setIsFavorited(true); // Update state to favorited
        }
      }
    } catch (err) {
      console.error("Unexpected error toggling favorite:", err);
      setFavoriteError("An unexpected error occurred while updating favorite status.");
    } finally {
      setIsFavoriteLoading(false); // Set loading false when operation is complete
    }
  };

  // If property data is not available, display a loading/error message
  if (!property) {
    return (
      <div className="text-center p-8 text-lg text-red-500">
        Property details are unavailable at the moment.
      </div>
    );
  }

  // Fallback for initial date display if created_at is null
  const initialDateDisplay = property.created_at
    ? new Date(property.created_at).toLocaleDateString('en-CA')
    : 'N/A';

  return (
    <div className="max-w-3xl mx-auto p-4">
      <div className="flex justify-between items-start">
        <h1 className="text-3xl font-bold mb-4">{property.title}</h1>
        {/* Favorite Button: Only show if user context is available */}
        {user && (
            <button
                onClick={handleToggleFavorite}
                disabled={isFavoriteLoading || !property?.id} // Disable during loading or if no property ID
                className={`px-4 py-2 rounded text-white font-semibold transition-colors duration-150 ease-in-out
                            ${isFavorited ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'}
                            ${isFavoriteLoading ? 'opacity-50 cursor-not-allowed' : ''}
                            ml-4`} // Added margin-left for spacing
            >
              {isFavoriteLoading ? '...' : (isFavorited ? 'Unfavorite' : 'Favorite')}
            </button>
        )}
      </div>
      {/* Display favorite error message if any */}
      {favoriteError && <p className="text-red-500 text-sm mb-2">{favoriteError}</p>}

      <div className="bg-gray-50 p-6 rounded-lg shadow mb-6">
        <p className="mb-2 text-2xl font-semibold text-green-700">
          Price: ₹{property.price.toLocaleString()}
        </p>
        <p className="mb-4 text-gray-800 text-md">{property.description}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 mt-4 text-md">
          <p><strong>Location:</strong> {property.location_text}</p>
          <p><strong>Property Type:</strong> {property.property_type}</p>
          <p><strong>Listing For:</strong> {property.listing_type}</p>
          <p><strong>Configuration:</strong> {property.bhk_type}</p>
          <p><strong>Area:</strong> {property.area} sqft</p>
          <p><strong>Posted On:</strong> {displayDate || initialDateDisplay}</p>
        </div>
      </div>

      <h2 className="text-2xl font-semibold mt-8 mb-4">Images</h2>
      {images && images.length > 0 ? (
        <div className="mt-8 max-w-lg mx-auto">
          <Carousel opts={{ loop: images.length > 1 }} className="w-full">
            <CarouselContent>
              {images.map((img) => (
                img.image_url && (
                  <CarouselItem key={img.id}>
                    <div className="p-1">
                      <img
                        src={img.image_url}
                        alt={`Image ${img.id} of ${property.title}`}
                        className="w-full h-auto aspect-[16/9] object-cover rounded-lg shadow-md"
                        // Add onError to handle broken image links
                        onError={(e) => {
                          e.currentTarget.src = 'https://placehold.co/600x400/CCCCCC/FFFFFF?text=No+Image'; // Placeholder image
                          e.currentTarget.onerror = null; // Prevent infinite loop if placeholder also fails
                        }}
                      />
                    </div>
                  </CarouselItem>
                )
              ))}
            </CarouselContent>
            {/* Show navigation buttons only if there's more than one image */}
            {images.length > 1 && (
              <>
                <CarouselPrevious />
                <CarouselNext />
              </>
            )}
          </Carousel>
        </div>
      ) : (
        <p className="mt-4 italic text-gray-500 text-center">No images available for this property.</p>
      )}
    </div>
  );
}
