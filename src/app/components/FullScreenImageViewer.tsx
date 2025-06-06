// src/app/components/FullScreenImageViewer.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { FaArrowLeft, FaArrowRight, FaTimes } from 'react-icons/fa';
import type { ImageType } from '@/app/property/[id]/page';

interface FullScreenImageViewerProps {
  images: ImageType[];
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showPrevious = () => {
    setCurrentIndex((prevIndex) => (prevIndex > 0 ? prevIndex - 1 : images.length - 1));
  };

  const showNext = () => {
    setCurrentIndex((prevIndex) => (prevIndex < images.length - 1 ? prevIndex + 1 : 0));
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50">
      {/* Close Button */}
      <button onClick={onClose} className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300">
        <FaTimes />
      </button>

      {/* Previous Button */}
      {images.length > 1 && (
        <button onClick={showPrevious} className="absolute left-4 text-white text-3xl p-2 rounded-full hover:bg-white hover:bg-opacity-20">
          <FaArrowLeft />
        </button>
      )}

      {/* Image Display */}
      <div className="max-w-[90vw] max-h-[90vh] flex items-center justify-center">
        <img
          src={images[currentIndex]?.image_url || ''}
          alt={`Property image ${currentIndex + 1}`}
          className="max-w-full max-h-full object-contain"
        />
      </div>
      
      {/* Next Button */}
      {images.length > 1 && (
         <button onClick={showNext} className="absolute right-4 text-white text-3xl p-2 rounded-full hover:bg-white hover:bg-opacity-20">
          <FaArrowRight />
        </button>
      )}
    </div>
  );
};
