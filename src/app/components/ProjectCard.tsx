// src/app/components/ProjectCard.tsx
'use client';

import Link from 'next/link';
import { Building, Calendar, MapPin } from 'lucide-react';
import { Project } from '@/lib/types';

type ProjectCardProps = {
  project: Project;
};

export function ProjectCard({ project }: ProjectCardProps) {
  // FIX: The database already provides the full URL.
  // Use it directly and only provide a fallback if it's null.
  const imageUrl = project.primary_image || 'https://placehold.co/600x400/e2e8f0/334155?text=No+Image';

  // Compatibility with updated DB (new-admin-features): prices are AED
  // (price_currency=AED), low_price can be 0/null, high_price can be null.
  // Basic version keeps the simple card but formats AED correctly instead
  // of the old INR Lakh logic.
  const formatAed = (v: number | null | undefined): string | null => {
    if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
    const n = Number(v);
    if (n >= 1000000) {
      const m = n / 1000000;
      return `${Number.isInteger(m) ? m.toString() : m.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    if (n >= 1000) {
      const k = n / 1000;
      return `${Number.isInteger(k) ? k.toString() : k.toFixed(1).replace(/\.?0+$/, '')}K`;
    }
    return n.toLocaleString();
  };
  const low = formatAed(project.low_price);
  const high = formatAed(project.high_price);
  const priceLabel = low ? (high && high !== low ? `AED ${low} - ${high}` : `AED ${low}`) : 'Price on request';

  // Keep basic route (/project/slug) but fall back to id if slug is missing
  // so the card never links to /project/undefined with the new schema.
  const href = project.slug ? `/project/${project.slug}` : `/project/${project.id}`;

  return (
    <Link href={href} className="block shadow-neumorphic-outset hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all duration-300 rounded-3xl p-1 group flex flex-col bg-bg-color h-full">
      <div className="relative">
        <div className="w-full h-48 bg-bg-color rounded-2xl overflow-hidden shadow-neumorphic-inset">
          <img
            src={imageUrl}
            alt={`Image of ${project.name}`}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              e.currentTarget.src = 'https://placehold.co/600x400/e2e8f0/334155?text=Image+Error';
              e.currentTarget.onerror = null;
            }}
          />
        </div>
      </div>

      <div className="flex flex-col flex-grow p-4">
        <h2 className="text-lg font-semibold truncate text-text-color-dark" title={project.name || undefined}>
          {project.name || 'N/A'}
        </h2>
        <p className="text-sm text-text-color-light flex items-center gap-1 truncate" title={project.location_name || undefined}>
          <MapPin size={12} /> {project.location_name || 'Location not specified'}
        </p>

        <div className="mt-2">
          <p className="text-xl font-bold text-success-color flex items-center">
            {priceLabel}
          </p>
        </div>

        <div className="mt-3 pt-3 border-t border-shadow-dark/10 text-sm text-text-color-light space-y-1">
            <p className="flex items-center gap-2"><Building size={14}/> {project.developer_name || 'Developer not specified'}</p>
            <p className="flex items-center gap-2"><Calendar size={14}/> {project.delivery_date ? `Possession by ${new Date(project.delivery_date).toLocaleDateString()}` : 'Date not available'}</p>
        </div>
      </div>
    </Link>
  );
}