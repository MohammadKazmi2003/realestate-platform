'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { FaWhatsapp } from 'react-icons/fa';

type WhatsAppButtonProps = {
  phoneNumber: string | null;
  propertyTitle: string;
  className?: string;
  children?: React.ReactNode;
  propertyId: string;
  ownerId: string;
};

export const WhatsAppButton: React.FC<WhatsAppButtonProps> = ({
  phoneNumber,
  propertyTitle,
  className,
  children,
}) => {
  const handleWhatsAppClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!phoneNumber) return;

    const message = encodeURIComponent(`Hello, I'm interested in your property "${propertyTitle}". Kindly share more details regarding it.`);
    // Remove all non-digit characters to ensure a valid wa.me link
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const whatsappUrl = `https://wa.me/${cleanPhoneNumber}?text=${message}`;
    
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
  };

  if (!phoneNumber) {
    return null;
  }

  return (
    <button
      onClick={handleWhatsAppClick}
      title="Contact owner on WhatsApp"
      className={cn(
        'neumorphic-button bg-green-500 hover:bg-green-600 text-white',
        'flex items-center justify-center gap-2', // Ensure flex properties for alignment
        className
      )}
    >
      {/* If children are provided, render them. Otherwise, render the default icon and text. */}
      {children || (
        <>
          <FaWhatsapp size={18} />
          <span className="text-sm font-medium hidden sm:inline">Contact Owner</span>
        </>
      )}
    </button>
  );
};
