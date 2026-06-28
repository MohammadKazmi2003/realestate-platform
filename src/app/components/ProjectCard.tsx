'use client';

import Link from 'next/link';
import { Building, Calendar, IndianRupee, MapPin } from 'lucide-react';
import { Project } from '@/lib/types';

type ProjectCardProps = {
  project: Project;
};

export function ProjectCard({ project }: ProjectCardProps) {
  const imageUrl = project.primary_image || 'https://placehold.co/600x400/e2e8f0/334155?text=No+Image';

  return (
    <Link href={`/projects/${project.id}`} className="block shadow-neumorphic-outset hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all duration-300 rounded-3xl p-1 group flex flex-col bg-bg-color h-full">
      <div className="relative">
        <div className="w-full h-48 bg-bg-color rounded-2xl overflow-hidden shadow-neumorphic-inset">
          <img
            src={imageUrl}
            alt={project.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = 'https://placehold.co/600x400/e2e8f0/334155?text=Image+Error';
            }}
          />
        </div>
      </div>

      <div className="flex flex-col flex-grow p-4">
        <h2 className="text-lg font-semibold truncate text-text-color-dark" title={project.name}>
          {project.name}
        </h2>
        <p className="text-sm text-text-color-light flex items-center gap-1 truncate" title={project.location_name || undefined}>
          <MapPin size={12} /> {project.location_name || 'Location not specified'}
        </p>

        <div className="mt-2">
          <p className="text-xl font-bold text-success-color flex items-center">
            <IndianRupee size={18} />
            {project.low_price ? `${(project.low_price / 100000).toFixed(1)}L - ${(project.high_price / 100000).toFixed(1)}L` : 'Price on request'}
          </p>
        </div>

        <div className="mt-3 pt-3 border-t border-shadow-dark/10 text-sm text-text-color-light space-y-1">
          <p className="flex items-center gap-2"><Building size={14} /> {project.developer_name}</p>
          <p className="flex items-center gap-2">
            <Calendar size={14} />
            {project.delivery_date ? `Possession by ${new Date(project.delivery_date).toLocaleDateString()}` : 'Date not available'}
          </p>
        </div>
      </div>
    </Link>
  );
}
