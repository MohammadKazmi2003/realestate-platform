// src/app/components/FullScreenImageViewer.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { FaArrowLeft, FaArrowRight, FaTimes } from 'react-icons/fa';
// UPDATE THE IMPORTED TYPE to use our new central types file
import type { MediaItem } from '@/lib/types';

interface FullScreenImageViewerProps {
  // UPDATE THE PROP TYPE
  images: MediaItem[];
  initialIndex: number;
  onClose: () => void;
}

export const FullScreenImageViewer: React.FC<FullScreenImageViewerProps> = ({ images, initialIndex, onClose }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') showPrevious();
      if (e.key === 'ArrowRight') showNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Note: Empty dependency array is correct here as functions don't change

  const showPrevious = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCurrentIndex((prevIndex) => (prevIndex > 0 ? prevIndex - 1 : images.length - 1));
  };

  const showNext = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCurrentIndex((prevIndex) => (prevIndex < images.length - 1 ? prevIndex + 1 : 0));
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300 transition-colors p-2 z-10">
        <FaTimes />
      </button>

      {images.length > 1 && (
        <button onClick={showPrevious} className="absolute left-4 text-white text-4xl p-2 rounded-full hover:bg-white/20 transition-colors z-10">
          <FaArrowLeft />
        </button>
      )}

      <div className="max-w-[90vw] max-h-[90vh] flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        <img
          // THE FIX IS HERE: Use `media_url` and do not fall back to an empty string.
          // React handles `undefined` src gracefully by not rendering the attribute, which prevents the error.
          src={images[currentIndex]?.media_url}
          alt={`Property image ${currentIndex + 1}`}
          className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
        />
      </div>
      
      {images.length > 1 && (
         <button onClick={showNext} className="absolute right-4 text-white text-4xl p-2 rounded-full hover:bg-white/20 transition-colors z-10">
          <FaArrowRight />
        </button>
      )}
    </div>
  );
};