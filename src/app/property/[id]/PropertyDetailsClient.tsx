// src/app/property/[id]/PropertyDetailsClient.tsx (now in its new location)

'use client'

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel'

type Property = {
  id: string;
  title: string;
  description: string;
  price: number;
  area: number;
  location_text: string;
  created_at: string;
  bhk_type: string;
  listing_type: string;
  property_type: string;
};

type Image = {
  id: string
  image_url: string
}

type Props = {
  property: Property;
  images: Image[];
};

export default function PropertyDetailClient({ property, images }: Props) {
  return (
    <div className="max-w-3xl mx-auto p-4">
      <h1 className="text-3xl font-bold mb-4">{property.title}</h1>
      <p className="mb-2 text-xl font-semibold">Price: ₹{property.price.toLocaleString()}</p>
      <p className="mb-2 text-gray-700">{property.description}</p>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 mt-4 text-lg">
        <p><strong>Location:</strong> {property.location_text}</p>
        <p><strong>Type:</strong> {property.property_type}</p>
        <p><strong>Listing For:</strong> {property.listing_type}</p>
        <p><strong>BHK Type:</strong> {property.bhk_type}</p>
        <p><strong>Area:</strong> {property.area} sqft</p>
        <p><strong>Posted On:</strong> {new Date(property.created_at).toLocaleDateString()}</p>
      </div>

      {images.length > 0 ? (
        <div className="mt-8 max-w-lg mx-auto">
          <Carousel>
            <CarouselPrevious />
            <CarouselContent>
              {images.map((img) => (
                <CarouselItem key={img.id}>
                  <img
                    src={img.image_url}
                    alt={`Image ${img.id} of ${property.title}`}
                    className="w-full rounded-lg object-cover max-h-96"
                  />
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselNext />
          </Carousel>
        </div>
      ) : (
        <p className="mt-4 italic text-gray-500 text-center">No images available for this property.</p>
      )}
    </div>
  )
}