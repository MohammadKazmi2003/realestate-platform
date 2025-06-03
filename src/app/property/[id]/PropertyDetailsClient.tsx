// src/app/property/[id]/PropertyDetailsClient.tsx
'use client';

import { useEffect, useState, useCallback } from 'react';
import type { FlattenedProperty, ImageType } from './page';
import useEmblaCarousel, { type EmblaCarouselType as CarouselApi } from "embla-carousel-react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel';

import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';


type Props = {
  property: FlattenedProperty | null;
  images: ImageType[]; // This array will now only contain validated, existing images
};

export default function PropertyDetailClient({ property, images }: Props) {
  const [displayDate, setDisplayDate] = useState<string>('');
  const { user } = useAuth();
  const router = useRouter();

  const [isFavorited, setIsFavorited] = useState<boolean>(false);
  const [isFavoriteLoading, setIsFavoriteLoading] = useState<boolean>(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  const [emblaApi, setEmblaApi] = useState<CarouselApi>();

  // Use useCallback for setApi to prevent unnecessary re-renders of Carousel
  const handleSetEmblaApi = useCallback((api: CarouselApi) => {
    setEmblaApi(api);
  }, []);

  // Embla re-initialization on images change
  useEffect(() => {
    if (emblaApi) {
      emblaApi.reInit(); // Re-initialize the carousel when content changes
      emblaApi.scrollTo(0); // Ensure it scrolls to the first slide
    }
  }, [emblaApi, images]); // FIX: Depend on the 'images' prop directly


  useEffect(() => {
    if (property?.created_at) {
      setDisplayDate(new Date(property.created_at).toLocaleDateString());
    }
  }, [property?.created_at]);

  useEffect(() => {
    if (!user || !property?.id) {
      setIsFavorited(false);
      return;
    }

    const checkFavoriteStatus = async () => {
      setIsFavoriteLoading(true);
      setFavoriteError(null);
      try {
        const { data, error } = await supabase
          .from('user_favorites')
          .select('*')
          .eq('user_id', user.id)
          .eq('property_id', property.id)
          .maybeSingle();

        if (error) {
          console.error("Error checking favorite status:", error);
          setFavoriteError("Could not check favorite status.");
          setIsFavorited(false);
        } else {
          setIsFavorited(!!data);
        }
      } catch (err) {
        console.error("Unexpected error checking favorite status:", err);
        setFavoriteError("An unexpected error occurred.");
        setIsFavorited(false);
      } finally {
        setIsFavoriteLoading(false);
      }
    };

    checkFavoriteStatus();
  }, [user, property?.id]);

  const handleToggleFavorite = async () => {
    if (!user) {
      alert("Please sign in to favorite properties.");
      router.push('/sign-in');
      return;
    }
    if (!property?.id) return;

    setIsFavoriteLoading(true);
    setFavoriteError(null);

    try {
      if (isFavorited) {
        const { error } = await supabase
          .from('user_favorites')
          .delete()
          .eq('user_id', user.id)
          .eq('property_id', property.id);

        if (error) {
          console.error("Error removing favorite:", error);
          setFavoriteError("Could not remove favorite.");
        } else {
          setIsFavorited(false);
        }
      } else {
        const { error } = await supabase
          .from('user_favorites')
          .insert({ user_id: user.id, property_id: property.id });

        if (error) {
          console.error("Error adding favorite:", error);
          setFavoriteError("Could not add favorite.");
        } else {
          setIsFavorited(true);
        }
      }
    } catch (err) {
      console.error("Unexpected error toggling favorite:", err);
      setFavoriteError("An unexpected error occurred while updating favorite status.");
    } finally {
      setIsFavoriteLoading(false);
    }
  };


  if (!property) {
    return (
      <div className="text-center p-8 text-lg text-red-500">
        Property details are unavailable at the moment.
      </div>
    );
  }

  const initialDateDisplay = property.created_at
    ? new Date(property.created_at).toLocaleDateString('en-CA')
    : 'N/A';

  // Removed validImages filtering here, as images prop is now pre-validated by page.tsx

  return (
    <div className="max-w-3xl mx-auto p-4">
      <div className="flex justify-between items-start">
        <h1 className="text-3xl font-bold mb-4">{property.title}</h1>
        {/* Favorite Button */}
        {user && (
            (<button
                onClick={handleToggleFavorite}
                disabled={isFavoriteLoading || !property?.id}
                className={`px-4 py-2 rounded text-white font-semibold transition-colors duration-150 ease-in-out
                            ${isFavorited ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'}
                            ${isFavoriteLoading ? 'opacity-50 cursor-not-allowed' : ''}
                            ml-4`}
            >
              {isFavoriteLoading ? '...' : (isFavorited ? 'Unfavorite' : 'Favorite')}
            </button>)
        )}
      </div>
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
      {/* Use images directly, as they are now pre-validated */}
      {images && images.length > 0 ? (
        <div className="mt-8 max-w-lg mx-auto">
          <Carousel opts={{ loop: images.length > 1 }} className="w-full" setApi={handleSetEmblaApi}>
            <CarouselContent>
              {images.map((img) => {
                console.log('Rendering image with src:', img.image_url);
                return (
                  <CarouselItem key={img.id}>
                    <div className="p-1">
                      <img
                        src={img.image_url}
                        alt={`Image ${img.id} of ${property.title}`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          console.error('Image failed to load (client-side fallback):', e.currentTarget.src);
                          e.currentTarget.src = 'https://placehold.co/600x400/CCCCCC/FFFFFF?text=Image+Load+Error';
                          e.currentTarget.onerror = null;
                        }}
                      />
                    </div>
                  </CarouselItem>
                );
              })}
            </CarouselContent>
            {images.length > 1 && ( <> <CarouselPrevious /> <CarouselNext /> </> )}
          </Carousel>
        </div>
      ) : (
        <p className="mt-4 italic text-gray-500 text-center">No images available for this property.</p>
      )}
    </div>
  );
}
