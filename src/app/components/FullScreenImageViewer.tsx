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

  // Preload neighbors only (not the whole gallery) so stepping through a
  // 20-photo gallery stays instant without extra bandwidth/memory.
  useEffect(() => {
    if (typeof window === 'undefined' || images.length <= 1) return;
    [currentIndex - 1, currentIndex + 1].forEach((offset) => {
      const m = images[(offset + images.length) % images.length];
      if (m?.media_url) {
        const pre = new window.Image();
        pre.src = m.media_url;
      }
    });
  }, [currentIndex, images]);

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

  // Sliding dot window for long galleries (max 5 dots + counter).
  const dotStart = images.length <= 5 ? 0 : Math.min(Math.max(currentIndex - 2, 0), images.length - 5);
  const visibleDots = images.slice(dotStart, dotStart + 5);

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
          alt={`Property image ${currentIndex + 1} of ${images.length}`}
          decoding="async"
          className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
        />
      </div>

      {images.length > 1 && (
        <div className="absolute bottom-5 inset-x-0 flex flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            {visibleDots.map((img, i) => {
              const idx = dotStart + i;
              return (
                <button
                  key={img.id ?? idx}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
                  aria-label={`Go to image ${idx + 1} of ${images.length}`}
                  className={`h-1.5 rounded-full transition-all duration-200 ${idx === currentIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/60 hover:bg-white/90'}`}
                />
              );
            })}
          </div>
          <div aria-live="polite" className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold text-white">
            {currentIndex + 1} / {images.length}
          </div>
        </div>
      )}
      
      {images.length > 1 && (
         <button onClick={showNext} className="absolute right-4 text-white text-4xl p-2 rounded-full hover:bg-white/20 transition-colors z-10">
          <FaArrowRight />
        </button>
      )}
    </div>
  );
};