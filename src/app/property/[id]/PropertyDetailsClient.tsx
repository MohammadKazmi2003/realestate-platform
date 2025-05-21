// src/app/property/[id]/PropertyDetailsClient.tsx
'use client';

import { useEffect, useState } from 'react';
import type { FlattenedProperty, ImageType } from './page';

// Temporarily remove Carousel to rule it out as an issue
// import {
//   Carousel,
//   CarouselContent,
//   CarouselItem,
//   CarouselPrevious,
//   CarouselNext,
// } from '@/components/ui/carousel';

type Props = {
  property: FlattenedProperty | null;
  images: ImageType[];
};

export default function PropertyDetailClient({ property, images }: Props) {
  const [displayDate, setDisplayDate] = useState<string>('');

  useEffect(() => {
    if (property?.created_at) {
      // Format the date on the client-side after hydration
      // This uses the client's locale, which is fine after initial render.
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
  
  // For initial render (before useEffect runs), prepare a consistent fallback or initial format
  // This helps ensure server and client output the same thing for the date initially.
  const initialDateDisplay = property.created_at 
    ? new Date(property.created_at).toLocaleDateString('en-CA') // YYYY-MM-DD format, good for consistency
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
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {images.map((img) => (
            img.image_url && (
              <div key={img.id} className="border rounded-lg overflow-hidden shadow">
                <img
                  src={img.image_url}
                  alt={`Image of ${property.title}`}
                  className="w-full h-48 object-cover" 
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = "https://via.placeholder.com/300x200?text=Image+Error";
                    (e.currentTarget as HTMLImageElement).alt = "Image failed to load";
                  }}
                />
              </div>
            )
          ))}
        </div>
      ) : (
        <p className="mt-4 italic text-gray-500 text-center">No images available for this property.</p>
      )}

      {/* // Carousel can be re-introduced here:
      {images && images.length > 0 ? (
        <div className="mt-8 max-w-lg mx-auto">
          <Carousel opts={{ loop: true }}>
            <CarouselContent>
              {images.map((img) => (
                img.image_url && (
                  <CarouselItem key={img.id}>
                    <img
                      src={img.image_url}
                      alt={`Image ${img.id} of ${property.title}`}
                      className="w-full rounded-lg object-cover max-h-96"
                    />
                  </CarouselItem>
                )
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
        </div>
      ) : (
        <p className="mt-4 italic text-gray-500 text-center">No images available.</p>
      )}
      */}
    </div>
  );
}