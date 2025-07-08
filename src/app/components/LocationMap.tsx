'use client';

import React from 'react';
import { MapPin } from 'lucide-react';

type LocationMapProps = {
  latitude: number | null;
  longitude: number | null;
};

export const LocationMap: React.FC<LocationMapProps> = ({ latitude, longitude }) => {
  // Gracefully handle cases where coordinates are missing
  if (!latitude || !longitude) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-bg-color shadow-neumorphic-inset rounded-2xl text-text-color-light">
        <MapPin className="w-12 h-12 mb-4" />
        <p className="font-semibold">Location data not available</p>
      </div>
    );
  }

  // Construct the Google Maps embed URL
  const mapSrc = `https://www.google.com/maps?q=${latitude},${longitude}&hl=es;z=14&output=embed`;

  return (
    <div className="aspect-w-16 aspect-h-9 shadow-neumorphic-inset rounded-2xl overflow-hidden">
      <iframe
        src={mapSrc}
        width="100%"
        height="450"
        style={{ border: 0 }}
        allowFullScreen={true}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        title="Property Location"
      ></iframe>
    </div>
  );
};
