'use client';

import Link from 'next/link';
import { ListingCarousel } from './ListingCarousel';
import { formatMoneyRange, formatBedsList, formatPossession, formatProgress } from '@/lib/format';
import { tenant } from '@/lib/tenant';
import { Building, Calendar, MapPin, BedDouble, Wallet } from 'lucide-react';
import { Project } from '@/lib/types';

function formatAedRange(low?: number | null, high?: number | null): string {
  return formatMoneyRange(low, high, tenant.projectCurrency);
}

type ProjectCardProps = {
  project: Project;
};

export function ProjectCard({ project }: ProjectCardProps) {
  // Full gallery, uncapped — ListingCarousel lazy-windows it (current ± 1 +
  // preload-next) so long galleries cost ~1 download until the user swipes.
  const gallery = [project.primary_image, ...(project.all_images || [])]
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .filter((u, i, arr) => arr.indexOf(u) === i);
  const bedsSummary = formatBedsList(project.bedrooms_list);
  const possession = formatPossession(project.delivery_date);
  const progress = formatProgress(project.construction_progress_percent ?? null);

  return (
    <div className="block shadow-neumorphic-outset hover:shadow-[6px_6px_12px_var(--shadow-dark),-6px_-6px_12px_var(--shadow-light)] transition-all duration-300 rounded-3xl p-1 group flex flex-col bg-bg-color h-full">
      <div className="relative">
        <ListingCarousel
          images={gallery}
          alt={project.name}
          linkHref={`/projects/${project.id}`}
        />
      </div>

      <div className="flex flex-col flex-grow p-4">
        <Link href={`/projects/${project.id}`}>
          <h2 className="text-lg font-semibold truncate text-text-color-dark" title={project.name}>
            {project.name}
          </h2>
        </Link>
        <p className="text-sm text-text-color-light flex items-center gap-1 truncate" title={project.location_name || undefined}>
          <MapPin size={12} /> {project.location_name || 'Location not specified'}
        </p>

        <div className="mt-2">
          <p className="text-xl font-bold text-success-color flex items-center">
            {formatAedRange(project.low_price, project.high_price)}
          </p>
        </div>

        {(bedsSummary || project.unit_count) && (
          <p className="mt-2 text-sm font-semibold text-text-color-dark flex items-center gap-2" title={bedsSummary || undefined}>
            <BedDouble size={14} className="flex-shrink-0" />
            <span className="truncate">
              {bedsSummary || ''}
              {bedsSummary && project.unit_count ? ` · ${project.unit_count} units` : ''}
              {!bedsSummary && project.unit_count ? `${project.unit_count} units` : ''}
            </span>
          </p>
        )}

        {project.payment_plan_summary && (
          <p className="mt-1.5 text-sm font-semibold text-violet-700 flex items-center gap-2">
            <Wallet size={14} className="flex-shrink-0" />
            <span className="truncate">{project.payment_plan_summary} payment plan</span>
          </p>
        )}

        <div className="mt-3 pt-3 border-t border-shadow-dark/10 text-sm text-text-color-light space-y-1">
          <p className="flex items-center gap-2"><Building size={14} /> {project.developer_name}</p>
          {project.construction_phase && (
            <p className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
              <span className="truncate">
                {project.construction_phase.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                {progress != null ? ` · ${progress}% complete` : ''}
              </span>
            </p>
          )}
          {progress != null && (
            <div className="h-1.5 rounded-full bg-shadow-dark/10 overflow-hidden">
              <div className="h-full rounded-full bg-amber-500" style={{ width: `${progress}%` }} />
            </div>
          )}
          <p className="flex items-center gap-2">
            <Calendar size={14} />
            {possession ? `Possession by ${possession}` : 'Date not available'}
          </p>
        </div>
      </div>
    </div>
  );
}
