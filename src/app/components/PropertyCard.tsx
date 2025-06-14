'use client'

import Link from 'next/link'
import { WhatsAppButton } from './WhatsAppButton'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel'
import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PropertyCardProps = {
  property: {
    id: string;
    title: string | null;
    location_text: string | null;
    price: number | null;
    area_sqft: number | null;
    owner_phone?: string | null; // Optional for cards where owner isn't relevant
    user_id?: string; // Optional
    images: { image_url: string }[]; // Changed to accept an array of images
  };
  actions?: React.ReactNode; // To pass Edit/Delete buttons for my-listings
}

export function PropertyCard({ property, actions }: PropertyCardProps) {
  // Defensive check for images to ensure it's always an array
  const images = Array.isArray(property.images) && property.images.length > 0
    ? property.images
    : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }];

  return (
    <div className="shadow-neumorphic-outset hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all duration-300 rounded-3xl p-1 group flex flex-col bg-bg-color">
      <div className="relative">
        <Carousel className="w-full rounded-2xl overflow-hidden shadow-neumorphic-inset">
          <CarouselContent>
            {images.map((img, index) => (
              <CarouselItem key={index}>
                <Link href={`/property/${property.id}`}>
                  <div className="w-full h-48 bg-bg-color">
                    <img
                      src={img.image_url}
                      alt={`Image ${index + 1} of ${property.title}`}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      onError={(e) => {
                        e.currentTarget.src = 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=Image+Error';
                        e.currentTarget.onerror = null;
                      }}
                    />
                  </div>
                </Link>
              </CarouselItem>
            ))}
          </CarouselContent>
          {images.length > 1 && (
            <>
              <CarouselPrevious className="absolute left-2" />
              <CarouselNext className="absolute right-2" />
            </>
          )}
        </Carousel>
      </div>

      <div className="flex flex-col flex-grow p-4">
        <Link href={`/property/${property.id}`} className="flex-grow">
          <h2 className="text-lg font-semibold truncate text-text-color-dark" title={property.title || undefined}>
            {property.title || 'N/A'}
          </h2>
          <p className="text-sm text-text-color-light flex items-center gap-1 truncate" title={property.location_text || undefined}>
            <MapPin size={12} /> {property.location_text || 'Location not specified'}
          </p>
          <div className="mt-2">
            <p className="text-xl font-bold text-success-color">
              {property.price ? `₹${property.price.toLocaleString()}` : 'Price N/A'}
            </p>
            <p className="text-sm text-text-color-light">
              {property.area_sqft ? `${property.area_sqft} sqft` : 'Area N/A'}
            </p>
          </div>
        </Link>
        <div className="mt-4 flex justify-between items-center">
            {actions ? (
                <div className="flex-1 flex gap-2">{actions}</div>
            ) : (
                <Link href={`/property/${property.id}`} className="font-medium text-text-color-dark flex items-center gap-1 hover:gap-2 transition-all text-sm">
                    View Details
                </Link>
            )}

            {property.owner_phone && property.user_id && (
                <WhatsAppButton
                    phoneNumber={property.owner_phone}
                    propertyTitle={property.title || ''}
                    propertyId={property.id}
                    ownerId={property.user_id}
                    className={cn("!p-3 rounded-full neumorphic-button !bg-green-500 hover:!bg-green-600 !text-white", {
                        "ml-auto": !actions // Push to the right if there are no actions
                    })}
                />
            )}
        </div>
      </div>
    </div>
  )
}
