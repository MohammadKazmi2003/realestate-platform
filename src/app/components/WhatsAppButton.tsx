// src/app/components/WhatsAppButton.tsx
'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { FaWhatsapp } from 'react-icons/fa';
import { supabase } from '@/lib/supabaseClient'; // Import the Supabase client
import { useAuth } from '@/context/AuthContext';   // Import the useAuth hook

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
  const { user } = useAuth(); // Get the currently logged-in user

  const handleWhatsAppClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!phoneNumber) return;

    // --- Start of Logging Logic ---
    // This block sends the event to your Supabase table.
    try {
      const { error } = await supabase.from('event_logs').insert({
        user_id: user?.id, // The user who clicked the button
        property_id: propertyId,
        event_type: 'whatsapp_click',
      });

      if (error) {
        // Log the error to the console for debugging, but don't block the user
        console.error('Error logging WhatsApp click:', error);
      }
    } catch (error) {
      console.error('An unexpected error occurred while logging:', error);
    }
    // --- End of Logging Logic ---

    const message = encodeURIComponent(`Hello, I'm interested in your property "${propertyTitle}". Kindly share more details regarding it.`);
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
      {children || (
        <>
          <FaWhatsapp size={18} />
          <span className="text-sm font-medium hidden sm:inline">Contact Owner</span>
        </>
      )}
    </button>
  );
};
