// src/app/components/ChatPropertyCard.tsx
'use client';

import Link from 'next/link';
import { IndianRupee, MapPin, BedDouble } from 'lucide-react';

type PropertyCardProps = {
  property: {
    title: string;
    listing_type: string;
    image_url?: string | null;
    price?: number | null;
    location?: string | null;
    bedrooms?: number | null;
    page_link: string;
  };
};

export function ChatPropertyCard({ property }: PropertyCardProps) {
  const displayImage = property.image_url || 'https://placehold.co/600x400/e2e8f0/334155?text=No+Image';
  
  return (
    <div className="bg-white/50 backdrop-blur-sm border border-gray-200/50 rounded-2xl shadow-md overflow-hidden w-full max-w-xs shrink-0 snap-start">
      <div className="w-full h-40 bg-gray-200">
        <img src={displayImage} alt={`Image of ${property.title}`} className="w-full h-full object-cover" />
      </div>
      <div className="p-4 space-y-2">
        <p className="text-xs font-semibold uppercase text-blue-600">{property.listing_type}</p>
        <h3 className="font-bold text-gray-800 truncate">{property.title}</h3>
        
        {property.price && (
          <p className="text-lg font-bold text-gray-900 flex items-center">
            <IndianRupee size={16} className="mr-1" /> 
            {(property.price / 100000).toFixed(1)}L
          </p>
        )}

        <div className="text-sm text-gray-600 space-y-1">
          {property.location && (
            <p className="flex items-center gap-2">
              <MapPin size={14} /> <span className="truncate">{property.location}</span>
            </p>
          )}
          {property.bedrooms !== null && (
             <p className="flex items-center gap-2">
              <BedDouble size={14} /> <span>{property.bedrooms === 0 ? 'Studio' : `${property.bedrooms} Bedrooms`}</span>
            </p>
          )}
        </div>
        
        <Link href={property.page_link} target="_blank" rel="noopener noreferrer">
          <button className="w-full mt-2 bg-blue-600 text-white font-semibold py-2 rounded-lg hover:bg-blue-700 transition-colors">
            View Details
          </button>
        </Link>
      </div>
    </div>
  );
}
