'use client';

import Image from 'next/image';
import { useState } from 'react';

// Listing photos come from arbitrary third-party hosts (Supabase, placeholder
// services, developer CDNs like propertyfinder). next/image throws at render
// time for any host missing from remotePatterns — so unknown hosts fall back
// to a plain <img> instead of crashing the card.
const OPTIMIZED_HOSTS = new Set([
  'kueunpcwzvytbyaogyqs.supabase.co',
  '127.0.0.1',
  'localhost',
  'placehold.co',
]);

function isOptimizable(src: string): boolean {
  try {
    if (src.startsWith('/') || src.startsWith('data:') || src.startsWith('blob:')) return true;
    const u = new URL(src);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (OPTIMIZED_HOSTS.has(u.hostname)) return true;
    // Covered by the *.propertyfinder.com remotePattern.
    if (u.hostname === 'propertyfinder.com' || u.hostname.endsWith('.propertyfinder.com')) return true;
    return false;
  } catch {
    return false;
  }
}

type ListingImageProps = {
  src: string;
  alt: string;
  fill?: boolean;
  sizes?: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  fallbackSrc?: string;
};

export function ListingImage({
  src,
  alt,
  fill,
  sizes,
  className,
  loading = 'lazy',
  fallbackSrc = 'https://placehold.co/600x400/e2e8f0/334155?text=Image+Error',
}: ListingImageProps) {
  const [failed, setFailed] = useState(false);
  const effectiveSrc = failed ? fallbackSrc : src;

  if (!isOptimizable(effectiveSrc)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={effectiveSrc}
        alt={alt}
        loading={loading}
        className={className}
        style={fill ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } : undefined}
        onError={() => setFailed(true)}
      />
    );
  }

  if (fill) {
    return (
      <Image
        src={effectiveSrc}
        alt={alt}
        fill
        sizes={sizes}
        loading={loading}
        className={className}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <Image
      src={effectiveSrc}
      alt={alt}
      width={600}
      height={400}
      sizes={sizes}
      loading={loading}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
