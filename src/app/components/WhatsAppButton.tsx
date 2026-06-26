// src/app/components/WhatsAppButton.tsx
'use client';

import React, { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { FaWhatsapp } from 'react-icons/fa';
import { useAuth } from '@/context/AuthContext';

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
  propertyId,
  ownerId,
}) => {
  const { user } = useAuth();

  const handleWhatsAppClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!phoneNumber) return;

    // Fire-and-forget counter increment via server endpoint — never blocks the user
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'whatsapp_click',
        user_id: user?.id,
        property_id: propertyId,
        owner_id: ownerId,
      }),
    }).catch(() => {
      // Counter failures are non-critical; never surface to user
    });

    const message = encodeURIComponent(`Hello, I'm interested in your property "${propertyTitle}". Kindly share more details regarding it.`);
    const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
    const whatsappUrl = `https://wa.me/${cleanPhoneNumber}?text=${message}`;
    
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
  }, [phoneNumber, propertyTitle, propertyId, ownerId, user?.id]);

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
      {children || (
        <>
          <FaWhatsapp size={18} />
          <span className="text-sm font-medium hidden sm:inline">Contact Owner</span>
        </>
      )}
    </button>
  );
};
