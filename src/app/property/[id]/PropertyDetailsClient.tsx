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

type Props = {
  property: FlattenedProperty | null;
  images: ImageType[];
};

export default function PropertyDetailClient({ property, images }: Props) {
  const [displayDate, setDisplayDate] = useState<string>('');

  useEffect(() => {
    if (property?.created_at) {
      setDisplayDate(new Date(property.created_at).toLocaleDateString());
    }
  }, [property?.created_at]);

  if (!property) {
    return (
      <div className="text-center p-8 text-lg text-red-500">
        Property details are unavailable at the moment.
      </div>
    );
  }
  
  const initialDateDisplay = property.created_at 
    ? new Date(property.created_at).toLocaleDateString('en-CA') // YYYY-MM-DD for consistency
    : 'N/A';

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-3xl font-bold mb-4">{property.title}</h1>
      
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
        <div className="mt-8 max-w-lg mx-auto"> {/* Adjusted max-width for typical carousel display */}
          <Carousel opts={{ loop: images.length > 1 }} className="w-full"> {/* Ensure Carousel takes width */}
            <CarouselContent>
              {images.map((img) => (
                img.image_url && ( // Ensure image_url is not null
                  <CarouselItem key={img.id}>
                    <div className="p-1"> {/* Embla often uses an inner div for padding/styling */}
                      <img
                        src={img.image_url}
                        alt={`Image ${img.id} of ${property.title}`}
                        className="w-full h-auto aspect-[16/9] object-cover rounded-lg shadow-md" // Maintain aspect ratio
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).src = "https://via.placeholder.com/400x225?text=Image+Error";
                          (e.currentTarget as HTMLImageElement).alt = `Image ${img.id} failed to load`;
                        }}
                      />
                    </div>
                  </CarouselItem>
                )
              ))}
            </CarouselContent>
            {images.length > 1 && ( // Show controls only if multiple images
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