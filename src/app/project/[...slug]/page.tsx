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
      
      const { data, error: rpcError } = await supabase.rpc('get_project_by_slug', { p_slug: slug }).single();

      if (rpcError || !data) {
        console.error('Error fetching project details:', rpcError);
        setError('Failed to load project details.');
        setProject(null);
      } else {
        const projectData = data as ProjectDetails;
        setProject(projectData);

        // FIX: Since the API now sorts the images, the hero image is always the first one.
        if (projectData.images && projectData.images.length > 0) {
          setActiveImageUrl(projectData.images[0].url);
        }
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

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-5xl mx-auto">
        <div className="shadow-neumorphic-outset rounded-3xl p-6 md:p-8 space-y-12">
            <section>
                <h1 className="text-3xl font-bold text-text-color-dark mb-2">{project.name}</h1>
                <p className="text-lg text-text-color-light">by {project.developer.name}</p>
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
                {project.images && project.images.length > 1 && (
                    <div className="flex space-x-2 overflow-x-auto pb-2">
                        {project.images.map((image) => (
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
                <div className="prose max-w-none text-gray-600" dangerouslySetInnerHTML={{ __html: project.description_html }} />
            </section>
            
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Location</h2>
                <LocationMap latitude={project.latitude} longitude={project.longitude} />
            </section>
            
            <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">Amenities</h2>
                <div className="flex flex-wrap gap-3">
                    {project.amenities.map(amenity => (
                        <div key={amenity} className="bg-bg-color shadow-neumorphic-outset text-text-color-dark font-medium px-4 py-2 rounded-full text-sm">
                            {amenity}
                        </div>
                    ))}
                </div>
            </section>

             <section>
                <h2 className="text-2xl font-semibold mb-4 text-text-color-dark">FAQs</h2>
                <div className="space-y-4">
                {project.faqs.map(faq => (
                    <details key={faq.question} className="p-4 rounded-2xl shadow-neumorphic-outset">
                        <summary className="font-semibold cursor-pointer">{faq.question}</summary>
                        <p className="mt-2 text-text-color-light">{faq.answer}</p>
                    </details>
                ))}
                </div>
            </section>
        </div>
      </main>
    </div>
  );
}