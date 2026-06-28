'use client';

import Link from 'next/link';
import { IndianRupee, MapPin, BedDouble, Building } from 'lucide-react';

type PropertyCardProps = {
  property: {
    id: string;
    title: string;
    listing_type?: string;
    slug?: string;
    property_type_name?: string | null;
    images?: { image_url: string }[] | string;
    image_url?: string | null;
    price?: number | null;
    low_price?: number | null;
    high_price?: number | null;
    location_text?: string | null;
    location?: string | null;
    bhk_type_label?: string | null;
    developer_name?: string | null;
    bedrooms?: number | null;
  };
};

export function ChatPropertyCard({ property }: PropertyCardProps) {
  const isProject = property.listing_type === 'project';
  const displayImage = isProject
    ? (property.image_url || 'https://placehold.co/600x400/e2e8f0/334155?text=No+Image')
    : (Array.isArray(property.images) && property.images.length > 0
        ? property.images[0].image_url
        : 'https://placehold.co/600x400/e2e8f0/334155?text=No+Image');

  const locationText = property.location_text || property.location || null;
  const detailUrl = isProject ? `/projects/${property.id}` : `/property/${property.id}`;

  return (
    <div className="bg-white/50 backdrop-blur-sm border border-gray-200/50 rounded-2xl shadow-md overflow-hidden w-full max-w-xs shrink-0 snap-start">
      <div className="w-full h-40 bg-gray-200">
        <img src={displayImage} alt={property.title} className="w-full h-full object-cover" />
      </div>
      <div className="p-4 space-y-2">
        {isProject && property.developer_name && (
          <p className="text-xs font-semibold uppercase text-blue-600 flex items-center gap-1">
            <Building size={12} /> {property.developer_name}
          </p>
        )}
        {!isProject && (
          <p className="text-xs font-semibold uppercase text-blue-600">{property.property_type_name || 'Property'}</p>
        )}
        <h3 className="font-bold text-gray-800 truncate">{property.title}</h3>

        {isProject && property.low_price ? (
          <p className="text-lg font-bold text-gray-900 flex items-center">
            <IndianRupee size={16} className="mr-1" />
            {(property.low_price / 100000).toFixed(1)}L - {(property.high_price! / 100000).toFixed(1)}L
          </p>
        ) : property.price ? (
          <p className="text-lg font-bold text-gray-900 flex items-center">
            <IndianRupee size={16} className="mr-1" />
            {(property.price / 100000).toFixed(1)}L
          </p>
        ) : null}

        <div className="text-sm text-gray-600 space-y-1">
          {locationText && (
            <p className="flex items-center gap-2">
              <MapPin size={14} /> <span className="truncate">{locationText}</span>
            </p>
          )}
          {!isProject && property.bhk_type_label && (
            <p className="flex items-center gap-2">
              <BedDouble size={14} /> <span>{property.bhk_type_label}</span>
            </p>
          )}
          {isProject && property.bedrooms != null && (
            <p className="flex items-center gap-2">
              <BedDouble size={14} /> <span>{property.bedrooms} Bed</span>
            </p>
          )}
        </div>

        <Link href={detailUrl} target={isProject ? '_blank' : undefined} rel={isProject ? 'noopener noreferrer' : undefined}>
          <button className="w-full mt-2 bg-blue-600 text-white font-semibold py-2 rounded-lg hover:bg-blue-700 transition-colors">
            {isProject ? 'View Project' : 'View Details'}
          </button>
        </Link>
      </div>
    </div>
  );
}
