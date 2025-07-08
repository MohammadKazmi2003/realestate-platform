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
// UPDATED: Removed GalleryVerticalEnd
import { MapPin, Bed, Bath, Briefcase, Users, Ruler, Dot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FaWhatsapp } from 'react-icons/fa';
// ADDED: Imported a more suitable icon for balconies
import { MdBalcony } from "react-icons/md";

// Helper component for displaying an icon with a value
const DetailIcon = ({ icon: Icon, value, label }: { icon: React.ElementType, value: any, label: string }) => {
    // Return null if the value is null, undefined, or an empty string to avoid rendering empty items.
    if (value === null || value === undefined || value === '') return null;
    return (
        <div className="flex items-center gap-1.5" title={label}>
            <Icon className="h-4 w-4 text-text-color-light flex-shrink-0" />
            <span className="text-sm font-medium text-text-color-dark">{value}</span>
        </div>
    )
}

export type PropertyCardProps = {
  property: {
    id: string;
    title: string | null;
    location_text: string | null;
    price: number | null;
    area?: number | null;
    area_unit?: string | null;
    owner_phone?: string | null;
    user_id?: string;
    images: { image_url: string }[];
    property_type_name?: string | null;
    bhk_type_label?: string | null;
    bathrooms?: number | null;
    balconies?: number | null;
    cabins?: number | null;
    workstations?: number | null;
  };
  actions?: React.ReactNode;
}

export function PropertyCard({ property, actions }: PropertyCardProps) {
  const images = Array.isArray(property.images) && property.images.length > 0
    ? property.images
    : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }];

  const areaValue = property.area ? `${property.area} ${property.area_unit || 'sqft'}` : null;

  return (
    <div className="shadow-neumorphic-outset hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all duration-300 rounded-3xl p-1 group flex flex-col bg-bg-color h-full">
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
              {property.price ? `₹${property.price.toLocaleString()}` : 'Price on request'}
            </p>
          </div>
        </Link>
        
        <div className="mt-3 pt-3 border-t border-shadow-dark/10 flex flex-wrap items-center gap-x-3 gap-y-2">
            <DetailIcon icon={Ruler} value={areaValue} label="Area" />
            
            {property.property_type_name === 'Residential' && (
                <>
                    {areaValue && <Dot className="text-text-color-light/50" />}
                    <DetailIcon icon={Bed} value={property.bhk_type_label} label="Bedrooms" />
                    {property.bathrooms && <Dot className="text-text-color-light/50" />}
                    <DetailIcon icon={Bath} value={property.bathrooms} label="Bathrooms" />
                    {property.balconies && <Dot className="text-text-color-light/50" />}
                    {/* FIXED: Using the new MdBalcony icon */}
                    <DetailIcon icon={MdBalcony} value={property.balconies} label="Balconies" />
                </>
            )}
            {property.property_type_name === 'Commercial' && (
                <>
                    {areaValue && <Dot className="text-text-color-light/50" />}
                    <DetailIcon icon={Briefcase} value={property.cabins} label="Cabins" />
                    {property.workstations && <Dot className="text-text-color-light/50" />}
                    <DetailIcon icon={Users} value={property.workstations} label="Workstations" />
                </>
            )}
        </div>

        <div className="mt-auto pt-4 flex justify-between items-center">
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
                    propertyTitle={property.title || 'this property'}
                    propertyId={property.id}
                    ownerId={property.user_id}
                    className={cn("!p-3 !w-auto !h-auto", {
                        "ml-auto": !actions
                    })}
                >
                    <FaWhatsapp size={18} />
                </WhatsAppButton>
            )}
        </div>
      </div>
    </div>
  )
}
