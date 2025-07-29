// src/app/newprojects/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import Header from '@/app/components/Header';
import { ProjectCard } from '@/app/components/ProjectCard';
import { Loader2 } from 'lucide-react';
import { Project } from '@/lib/types';

export default function NewProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProjects = async () => {
      setLoading(true);
      setError(null);

      const { data, error: rpcError } = await supabase.rpc('get_all_projects');

      if (rpcError) {
        console.error('Error fetching projects:', rpcError);
        setError('Failed to load new projects. Please try again later.');
        setProjects([]);
      } else {
        setProjects(data || []);
      }
      setLoading(false);
    };
    fetchProjects();
  }, []);

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <main className="p-4 sm:p-6 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8 text-center text-text-color-dark">New Projects</h1>
        {loading && <div className="flex justify-center py-20"><Loader2 className="animate-spin h-12 w-12 text-text-color-light" /></div>}
        {error && <div className="text-lg text-danger-color text-center py-10 bg-red-100 rounded-2xl p-4"><p className="font-semibold">Error</p><p className="text-sm mt-1">{error}</p></div>}

        {!loading && !error && projects.length === 0 && (
          <p className="text-lg text-center py-10 text-text-color-light">No new projects found. Check back soon!</p>
        )}

        {!loading && !error && projects.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}