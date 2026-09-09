// src/app/project/[...slug]/page.tsx
'use client';

import { useEffect, useState, use } from 'react';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { Loader2 } from 'lucide-react';
import { ProjectDetails } from '@/lib/types';
import { LocationMap } from '@/app/components/LocationMap';

export default function ProjectDetailsPage({ params: paramsPromise }: { params: Promise<{ slug: string[] }> }) {
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // This will hold the URL of the currently displayed large image.
  const [activeImageUrl, setActiveImageUrl] = useState<string | null>(null);

  const params = use(paramsPromise);
  const slug = params.slug.join('/');

  useEffect(() => {
    const fetchProjectDetails = async () => {
      setLoading(true);
      setError(null);

      // Primary: old RPC (basic version). Still supported as fallback in new schema.
      const { data, error: rpcError } = await supabase.rpc('get_project_by_slug', { p_slug: slug }).maybeSingle();

      if (!rpcError && data) {
        const projectData = data as ProjectDetails;
        setProject(projectData);

        // Old shape: images[{url}]. New shape (if RPC was updated): project_media[].
        const firstImage =
          (projectData.images && projectData.images[0]?.url) ||
          (projectData.project_media && projectData.project_media[0]?.storage_path_original) ||
          null;
        if (firstImage) setActiveImageUrl(firstImage);
        setLoading(false);
        return;
      }

      // Fallback: updated schema path via get_listing_details (used by
      // new-admin's /projects/[id]). Resolve slug -> id, then fetch details.
      try {
        let projectId: string | null = null;
        // If the slug segment is already a UUID (new-style link), use it directly.
        const maybeUuid = slug.split('/').pop() || '';
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(maybeUuid);
        if (isUuid) {
          projectId = maybeUuid;
        } else {
          const { data: row } = await supabase.from('projects').select('id').eq('slug', slug).maybeSingle();
          projectId = (row as any)?.id || null;
        }

        if (!projectId) throw rpcError || new Error('not found');

        const { data: details, error: detailsError } = await supabase.rpc('get_listing_details', { p_listing_id: projectId }).maybeSingle();
        if (detailsError || !details) throw detailsError || new Error('not found');

        // Normalize new shape to the basic ProjectDetails the UI renders.
        const d: any = details;
        const normalized: ProjectDetails = {
          id: d.id,
          name: d.title || d.name,
          title: d.title,
          slug,
          low_price: d.price_range?.low ?? d.low_price ?? null,
          high_price: d.price_range?.high ?? d.high_price ?? null,
          description_html: d.description_html || d.description || '',
          description: d.description || null,
          construction_phase: d.status?.phase || d.construction_phase || null,
          delivery_date: d.status?.delivery_date || d.delivery_date || null,
          developer: d.developer ? { name: d.developer.name, logo: d.developer.logo || null } : null,
          images: Array.isArray(d.project_media)
            ? d.project_media.map((m: any) => ({ url: m.storage_path_original, is_primary: !!m.is_primary }))
            : (d.images || []),
          project_media: d.project_media || null,
          amenities: d.amenities || [],
          faqs: d.faqs || [],
          unit_configurations: d.unit_configurations || [],
          latitude: d.latitude ?? null,
          longitude: d.longitude ?? null,
          price_range: d.price_range || null,
          status: d.status || null,
        };
        setProject(normalized);
        const first = (normalized.images && normalized.images[0]?.url) || null;
        if (first) setActiveImageUrl(first);
      } catch (e) {
        console.error('Error fetching project details:', rpcError || e);
        setError('Failed to load project details.');
        setProject(null);
      }
      setLoading(false);
    };
    fetchProjectDetails();
  }, [slug]);

  if (loading) {
    return (
        <div className="bg-bg-color min-h-screen">
            <Header />
            <div className="flex justify-center items-center h-[80vh]">
                <Loader2 className="animate-spin h-12 w-12 text-text-color-light" />
            </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="bg-bg-color min-h-screen">
        <Header />
        <div className="text-center p-8">
            <h1 className="text-2xl font-bold text-danger-color mb-4">Project Not Found</h1>
            <p className="text-gray-700">{error || 'The project you are looking for does not exist.'}</p>
        </div>
      </div>
    );
  }

  // Normalize for rendering: support both old (get_project_by_slug) and
  // new (get_listing_details) shapes without adding admin features.
  const displayName = (project as any)?.name || (project as any)?.title || 'Project';
  const developerName = (project as any)?.developer?.name || 'Developer not specified';
  const gallery: { url: string }[] =
    (project.images && project.images.length > 0)
      ? project.images
      : Array.isArray((project as any).project_media)
        ? (project as any).project_media.map((m: any) => ({ url: m.storage_path_original }))
        : [];
  const amenityLabels: string[] = Array.isArray(project.amenities)
    ? project.amenities.map((a: any) => (typeof a === 'string' ? a : a?.name).trim?.() || (typeof a === 'string' ? a : a?.name)).filter(Boolean)
    : [];
  const faqItems: { question: string; answer: string }[] = Array.isArray(project.faqs) ? project.faqs : [];

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-5xl mx-auto">
        <div className="shadow-neumorphic-outset rounded-3xl p-6 md:p-8 space-y-12">
            <section>
                <h1 className="text-3xl font-bold text-text-color-dark mb-2">{displayName}</h1>
                <p className="text-lg text-text-color-light">by {developerName}</p>
            </section>
            
            {/* --- IMAGE GALLERY SECTION --- */}
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Gallery</h2>
                <div className="bg-black rounded-lg mb-4 w-full aspect-video flex items-center justify-center shadow-neumorphic-inset">
                    {activeImageUrl ? (
                        <img src={activeImageUrl} alt="Main project view" className="w-full h-full object-contain rounded-lg" />
                    ) : (
                        <p className="text-white">No Image Available</p>
                    )}
                </div>
                {gallery.length > 1 && (
                    <div className="flex space-x-2 overflow-x-auto pb-2">
                        {gallery.map((image) => (
                            <img
                                key={image.url}
                                src={image.url}
                                alt="Project thumbnail"
                                onClick={() => setActiveImageUrl(image.url)}
                                className={`w-24 h-16 object-cover rounded-md flex-shrink-0 cursor-pointer border-2 transition-all ${activeImageUrl === image.url ? 'border-blue-600' : 'border-transparent'}`}
                            />
                        ))}
                    </div>
                )}
            </section>
            {/* --- END IMAGE GALLERY SECTION --- */}
            
            <section>
                <div className="prose max-w-none text-gray-600" dangerouslySetInnerHTML={{ __html: project.description_html || '' }} />
            </section>
            
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Location</h2>
                <LocationMap latitude={project.latitude} longitude={project.longitude} />
            </section>
            
            {amenityLabels.length > 0 && (
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Amenities</h2>
                <div className="flex flex-wrap gap-3">
                    {amenityLabels.map(amenity => (
                        <div key={amenity} className="bg-bg-color shadow-neumorphic-outset text-text-color-dark font-medium px-4 py-2 rounded-full text-sm">
                            {amenity}
                        </div>
                    ))}
                </div>
            </section>
            )}

             {faqItems.length > 0 && (
              <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">FAQs</h2>
                <div className="space-y-4">
                {faqItems.map(faq => (
                    <details key={faq.question} className="p-4 rounded-2xl shadow-neumorphic-outset">
                        <summary className="font-semibold cursor-pointer">{faq.question}</summary>
                        <p className="mt-2 text-text-color-light">{faq.answer}</p>
                    </details>
                ))}
                </div>
            </section>
             )}
        </div>
      </main>
    </div>
  );
}