'use client'

import Link from 'next/link'
import { ListingImage } from './ListingImage';
import { formatMoney, formatArea } from '@/lib/format';
import { tenant } from '@/lib/tenant';
import { WhatsAppButton } from './WhatsAppButton'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel'
// UPDATED: Removed GalleryVerticalEnd
import { MapPin, Bed, Bath, Briefcase, Users, Ruler, Dot, Sofa, Tag } from 'lucide-react'
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
    area_sqft?: number | null;
    area_unit?: string | null;
    owner_phone?: string | null;
    user_id?: string | null;
    images?: { image_url: string }[];
    image_url?: string | null;
    property_type_name?: string | null;
    /** ES returns `property_type`; PG RPCs return `property_type_name` — accept both. */
    property_type?: string | null;
    bhk_type_label?: string | null;
    /** ES/PG fallback may use `bhk_type` instead of `bhk_type_label`. */
    bhk_type?: string | null;
    bedrooms?: number | null;
    bathrooms?: number | null;
    balconies?: number | null;
    cabins?: number | null;
    workstations?: number | null;
    min_seats?: number | null;
    max_seats?: number | null;
    furnishing_status?: string | null;
    listing_purpose?: string | null;
  };
  actions?: React.ReactNode;
}

function isRentalPurpose(purpose?: string | null): boolean {
  if (!purpose) return false;
  return /rent|lease|\bpg\b/i.test(purpose);
}

function purposeBadgeLabel(purpose?: string | null): string | null {
  if (!purpose) return null;
  const p = purpose.trim().toLowerCase();
  if (p === 'rent') return 'For Rent';
  if (p === 'sell' || p === 'sale') return 'For Sale';
  if (p === 'lease') return 'For Lease';
  if (p === 'pg') return 'PG';
  return `For ${purpose.trim()}`;
}

function isResidentialType(typeName?: string | null): boolean {
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  return t.includes('residential') || t.includes('apartment') || t.includes('house') || t.includes('villa') || t.includes('flat') || t.includes('studio');
}

function isCommercialType(typeName?: string | null): boolean {
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  return t.includes('commercial') || t.includes('office') || t.includes('retail') || t.includes('shop');
}

function isLandType(typeName?: string | null): boolean {
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  return t.includes('land') || t.includes('plot');
}

export function PropertyCard({ property, actions }: PropertyCardProps) {
  const rawImages = Array.isArray(property.images) && property.images.length > 0
    ? property.images
    : property.image_url
      ? [{ image_url: property.image_url }]
      : [];
  const images = rawImages.length > 0
    ? rawImages
    : [{ image_url: 'https://placehold.co/600x400/DEE4ED/3D4A5C?text=No+Image' }];

  // `area` (ES card path) vs `area_sqft` (PG/RPC fallback path) — support both
  // so rental + sale cards always show area in sq. ft. when available.
  const rawArea = property.area ?? property.area_sqft ?? null;
  const areaValue = formatArea(rawArea, property.area_unit);

  const typeName = property.property_type_name ?? property.property_type ?? null;
  const bhkLabel = property.bhk_type_label ?? property.bhk_type ?? (
    property.bedrooms != null && property.bedrooms > 0 ? `${property.bedrooms} BHK` : null
  );
  const furnishing = property.furnishing_status ?? null;
  const listingPurpose = property.listing_purpose ?? null;
  const badgeLabel = purposeBadgeLabel(listingPurpose);
  const isRental = isRentalPurpose(listingPurpose);

  // The add-listing form saves subtype names (e.g. "Residential Apartment",
  // "Commercial Office") while older rows use parent names ("Residential").
  // Match by substring + fall back to data presence so rent + sale cards show
  // the same details that were entered in the form.
  const residentialByType = isResidentialType(typeName);
  const commercialByType = isCommercialType(typeName);
  const hasResidentialDetails = residentialByType || bhkLabel || property.bathrooms || property.balconies || furnishing;
  const hasCommercialDetails = commercialByType || property.cabins || property.workstations || property.min_seats || property.max_seats;

  return (
    <div className="shadow-neumorphic-outset hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all duration-300 rounded-3xl p-1 group flex flex-col bg-bg-color h-full">
      <div className="relative">
        <Carousel className="w-full rounded-2xl overflow-hidden shadow-neumorphic-inset">
          <CarouselContent>
            {images.map((img, index) => (
              <CarouselItem key={index}>
                <Link href={`/property/${property.id}`}>
                  <div className="w-full h-48 bg-bg-color relative">
                    <ListingImage
                      src={img.image_url}
                      alt={`Image ${index + 1} of ${property.title}`}
                      fill
                      sizes="(max-width: 768px) 100vw, 50vw"
                      loading="lazy"
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
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
        {badgeLabel && (
          <span className={cn(
            "absolute top-3 left-3 text-xs font-bold px-3 py-1 rounded-full shadow-neumorphic-outset",
            isRental ? "bg-blue-600 text-white" : "bg-success-color text-white"
          )}>
            {badgeLabel}
          </span>
        )}
        {typeName && (
          <span className="absolute top-3 right-3 text-xs font-semibold px-2.5 py-1 rounded-full bg-bg-color/90 text-text-color-dark backdrop-blur-sm">
            {typeName}
          </span>
        )}
      </div>

      <div className="flex flex-col flex-grow p-4">
        <Link href={`/property/${property.id}`} className="flex-grow">
          <h2 className="text-lg font-semibold truncate text-text-color-dark" title={property.title || undefined}>
            {property.title || 'N/A'}
          </h2>
          <p className="text-sm text-text-color-light flex items-center gap-1 truncate" title={property.location_text || undefined}>
            <MapPin size={12} /> {property.location_text || 'Location not specified'}
          </p>
          <div className="mt-2 flex items-baseline gap-1">
            <p className="text-xl font-bold text-success-color">
              {property.price ? formatMoney(property.price, tenant.propertyCurrency) : 'Price on request'}
            </p>
            {isRental && property.price ? (
              <span className="text-sm font-medium text-text-color-light">/mo</span>
            ) : null}
          </div>
          {listingPurpose && (
            <p className="mt-1 flex items-center gap-1 text-xs font-medium text-text-color-light">
              <Tag size={12} /> {badgeLabel ?? listingPurpose}
              {furnishing ? ` • ${furnishing}` : ''}
            </p>
          )}
        </Link>

        <div className="mt-3 pt-3 border-t border-shadow-dark/10 flex flex-wrap items-center gap-x-3 gap-y-2">
            <DetailIcon icon={Ruler} value={areaValue} label={areaValue ? `Area (${property.area_unit || 'sqft'})` : 'Area'} />

            {hasResidentialDetails && (
                <>
                    {areaValue && bhkLabel && <Dot className="text-text-color-light/50" />}
                    <DetailIcon icon={Bed} value={bhkLabel} label="Bedrooms" />
                    {bhkLabel && property.bathrooms ? <Dot className="text-text-color-light/50" /> : null}
                    <DetailIcon icon={Bath} value={property.bathrooms ? `${property.bathrooms} Bath` : null} label="Bathrooms" />
                    {property.bathrooms && property.balconies ? <Dot className="text-text-color-light/50" /> : null}
                    {/* FIXED: Using the new MdBalcony icon */}
                    <DetailIcon icon={MdBalcony} value={property.balconies ? `${property.balconies} Balcony` : null} label="Balconies" />
                    {(bhkLabel || property.bathrooms || property.balconies) && furnishing ? <Dot className="text-text-color-light/50" /> : null}
                    <DetailIcon icon={Sofa} value={furnishing} label="Furnishing" />
                </>
            )}
            {hasCommercialDetails && !hasResidentialDetails && (
                <>
                    {areaValue && property.cabins ? <Dot className="text-text-color-light/50" /> : null}
                    <DetailIcon icon={Briefcase} value={property.cabins ? `${property.cabins} Cabins` : null} label="Cabins" />
                    {property.cabins && (property.workstations || property.max_seats || property.min_seats) ? <Dot className="text-text-color-light/50" /> : null}
                    <DetailIcon
                      icon={Users}
                      value={(property.workstations || property.max_seats || property.min_seats) ? `${property.workstations ?? property.max_seats ?? property.min_seats} Seats` : null}
                      label="Workstations / Seats"
                    />
                </>
            )}
            {!hasResidentialDetails && !hasCommercialDetails && furnishing && (
                <>
                    {areaValue && <Dot className="text-text-color-light/50" />}
                    <DetailIcon icon={Sofa} value={furnishing} label="Furnishing" />
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
                    className={cn("!p-3 !w-auto !h-auto", !actions ? "ml-auto" : "")}
                >
                    <FaWhatsapp size={18} />
                </WhatsAppButton>
            )}
        </div>
      </div>
    </div>
  )
}
