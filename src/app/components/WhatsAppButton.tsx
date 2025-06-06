// src/app/components/WhatsAppButton.tsx
'use client';

import React from 'react';
import { cn } from '@/lib/utils'; // Using your existing cn utility
import { FaWhatsapp } from 'react-icons/fa';

type WhatsAppButtonProps = {
  phoneNumber: string;
  propertyTitle: string;
  className?: string; // To allow custom styling
  children?: React.ReactNode; // To allow custom content (text, icons, etc.)
};

export const WhatsAppButton: React.FC<WhatsAppButtonProps> = ({
  phoneNumber,
  propertyTitle,
  className,
  children,
}) => {
  const handleWhatsAppClick = (e: React.MouseEvent) => {
    // Prevent any parent Link components from navigating
    e.stopPropagation();
    e.preventDefault();

    const message = encodeURIComponent(`Hello, I'm interested in your property "${propertyTitle}",\n Kindly Share More Details Regarding It`);
    const cleanPhoneNumber = phoneNumber.replace(/\+/g, '').replace(/\s/g, '');
    const whatsappUrl = `https://wa.me/${cleanPhoneNumber}?text=${message}`;
    
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
  };

  // If no phone number, don't render anything
  if (!phoneNumber) {
    return null;
  }

  return (
    <button
      onClick={handleWhatsAppClick}
      title="Contact owner on WhatsApp"
      className={cn( // cn() merges default styles with custom ones
        'flex items-center justify-center gap-2 px-3 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 transition-colors',
        className // Your custom classes will be appended here
      )}
    >
      {/* If children are provided, render them. Otherwise, render a default. */}
      {children || (
        <>
          <FaWhatsapp size={18} />
          <span className="text-sm font-medium">Contact Owner</span>
        </>
      )}
    </button>
  );
};