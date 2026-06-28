'use client';

import { useEffect, useState, use } from 'react';
import Header from '@/app/components/Header';
import { Loader2 } from 'lucide-react';
import { ProjectDetails } from '@/lib/types';
import dynamic from 'next/dynamic';

const LocationMap = dynamic(() => import('@/app/components/LocationMap').then(m => ({ default: m.LocationMap })), {
  ssr: false,
  loading: () => <div className="h-64 bg-bg-color rounded-2xl shadow-neumorphic-inset flex items-center justify-center"><Loader2 className="animate-spin h-8 w-8" /></div>,
});

export default function ProjectDetailsPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const [project, setProject] = useState<ProjectDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeImageUrl, setActiveImageUrl] = useState<string | null>(null);

  const { id } = use(paramsPromise);

  useEffect(() => {
    const fetchProject = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${id}`);
        if (!res.ok) { setError('Project not found.'); return; }
        const data: ProjectDetails = await res.json();
        setProject(data);
        if (data.project_media?.length) {
          setActiveImageUrl(data.project_media[0].storage_path_original);
        }
      } catch { setError('Failed to load project details.'); }
      finally { setLoading(false); }
    };
    fetchProject();
  }, [id]);

  if (loading) return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <div className="flex justify-center items-center h-[80vh]"><Loader2 className="animate-spin h-12 w-12 text-text-color-light" /></div>
    </div>
  );

  if (error || !project) return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <div className="text-center p-8">
        <h1 className="text-2xl font-bold text-danger-color mb-4">Project Not Found</h1>
        <p className="text-gray-700">{error || 'The project you are looking for does not exist.'}</p>
      </div>
    </div>
  );

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-5xl mx-auto">
        <div className="shadow-neumorphic-outset rounded-3xl p-6 md:p-8 space-y-12">
          <section>
            <h1 className="text-3xl font-bold text-text-color-dark mb-2">{project.title}</h1>
            <p className="text-lg text-text-color-light">{project.developer?.name ? `by ${project.developer.name}` : ''}</p>
            {project.price_range?.low && (
              <p className="text-xl font-bold text-success-color mt-2">
                AED {project.price_range.low.toLocaleString()} - {project.price_range.high?.toLocaleString()}
              </p>
            )}
          </section>

          {project.project_media?.length > 0 && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Gallery</h2>
              <div className="bg-black rounded-lg mb-4 w-full aspect-video flex items-center justify-center shadow-neumorphic-inset">
                {activeImageUrl ? (
                  <img src={activeImageUrl} alt="Main project view" className="w-full h-full object-contain rounded-lg" />
                ) : (
                  <p className="text-white">No Image Available</p>
                )}
              </div>
              {project.project_media.length > 1 && (
                <div className="flex space-x-2 overflow-x-auto pb-2">
                  {project.project_media.map((image) => (
                    <img
                      key={image.id}
                      src={image.storage_path_original}
                      alt="Project thumbnail"
                      onClick={() => setActiveImageUrl(image.storage_path_original)}
                      className={`w-24 h-16 object-cover rounded-md flex-shrink-0 cursor-pointer border-2 transition-all ${
                        activeImageUrl === image.storage_path_original ? 'border-blue-600' : 'border-transparent'
                      }`}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {project.description_html && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">About</h2>
              <div className="prose max-w-none text-gray-600" dangerouslySetInnerHTML={{ __html: project.description_html }} />
            </section>
          )}

          {project.latitude && project.longitude && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Location</h2>
              <LocationMap latitude={project.latitude} longitude={project.longitude} />
            </section>
          )}

          {project.amenities?.length > 0 && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Amenities</h2>
              <div className="flex flex-wrap gap-3">
                {project.amenities.map(a => (
                  <div key={a.id} className="bg-bg-color shadow-neumorphic-outset text-text-color-dark font-medium px-4 py-2 rounded-full text-sm">{a.name}</div>
                ))}
              </div>
            </section>
          )}

          {project.unit_configurations?.length > 0 && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Unit Configurations</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left shadow-neumorphic-inset rounded-2xl overflow-hidden">
                  <thead>
                    <tr className="bg-bg-color text-text-color-light text-sm">
                      <th className="p-3">Type</th>
                      <th className="p-3">Bedrooms</th>
                      <th className="p-3">Area (sqft)</th>
                      <th className="p-3">Starting Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {project.unit_configurations.map(uc => (
                      <tr key={uc.id} className="border-t border-shadow-dark/10">
                        <td className="p-3 font-medium">{uc.property_type}</td>
                        <td className="p-3">{uc.bedrooms != null ? uc.bedrooms : '-'}</td>
                        <td className="p-3">{uc.area_from_sqft ? `${uc.area_from_sqft} - ${uc.area_to_sqft || uc.area_from_sqft}` : '-'}</td>
                        <td className="p-3">{uc.starting_price ? `AED ${uc.starting_price.toLocaleString()}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {project.faqs?.length > 0 && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">FAQs</h2>
              <div className="space-y-4">
                {project.faqs.map(faq => (
                  <details key={faq.id} className="p-4 rounded-2xl shadow-neumorphic-outset">
                    <summary className="font-semibold cursor-pointer">{faq.question}</summary>
                    <p className="mt-2 text-text-color-light">{faq.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          )}

          {project.project_videos && project.project_videos.length > 0 && (
            <section>
              <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Videos</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {project.project_videos.map((video, idx) => (
                  <video key={idx} controls className="w-full rounded-2xl shadow-neumorphic-outset">
                    <source src={video.video_storage_path} />
                  </video>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
