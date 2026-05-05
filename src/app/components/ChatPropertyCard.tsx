// src/app/components/ChatPropertyCard.tsx
'use client';

import Link from 'next/link';
import { IndianRupee, MapPin, BedDouble } from 'lucide-react';

type PropertyCardProps = {
  property: {
    id: string;
    title: string;
    property_type_name?: string | null;
    images?: { image_url: string }[];
    price?: number | null;
    location_text?: string | null;
    bhk_type_label?: string | null;
  };
};

export function ChatPropertyCard({ property }: PropertyCardProps) {
  const displayImage = property.images?.[0]?.image_url || 'https://placehold.co/600x400/e2e8f0/334155?text=No+Image';
  
  return (
    <div className="bg-white/50 backdrop-blur-sm border border-gray-200/50 rounded-2xl shadow-md overflow-hidden w-full max-w-xs shrink-0 snap-start">
      <div className="w-full h-40 bg-gray-200">
        <img src={displayImage} alt={`Image of ${property.title}`} className="w-full h-full object-cover" />
      </div>
      <div className="p-4 space-y-2">
        <p className="text-xs font-semibold uppercase text-blue-600">{property.property_type_name || 'Property'}</p>
        <h3 className="font-bold text-gray-800 truncate">{property.title}</h3>
        
        {property.price && (
          <p className="text-lg font-bold text-gray-900 flex items-center">
            <IndianRupee size={16} className="mr-1" /> 
            {(property.price / 100000).toFixed(1)}L
          </p>
        )}

        <div className="text-sm text-gray-600 space-y-1">
          {property.location_text && (
            <p className="flex items-center gap-2">
              <MapPin size={14} /> <span className="truncate">{property.location_text}</span>
            </p>
          )}
          {property.bhk_type_label && (
             <p className="flex items-center gap-2">
              <BedDouble size={14} /> <span>{property.bhk_type_label}</span>
            </p>
          )}
        </div>
        
        <Link href={`/property/${property.id}`}>
          <button className="w-full mt-2 bg-blue-600 text-white font-semibold py-2 rounded-lg hover:bg-blue-700 transition-colors">
            View Details
          </button>
        </Link>
      </div>
    </div>
  );
}
