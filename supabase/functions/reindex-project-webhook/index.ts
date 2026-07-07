import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      console.warn(`ES request failed (${response.status}), retry ${i + 1}/${retries}`);
    } catch (err) {
      console.warn(`ES network error (${err}), retry ${i + 1}/${retries}`);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, Math.pow(2, i) * 200));
  }
  throw new Error(`Failed after ${retries} retries`);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const { type, table, record, old_record } = payload;

    if (table !== 'projects') {
      return new Response(JSON.stringify({ message: `Ignoring ${table}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ES_URL = Deno.env.get('ELASTICSEARCH_URL') || 'http://host.docker.internal:9200';
    const ES_API_KEY = Deno.env.get('ELASTICSEARCH_API_KEY') || '';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ES_API_KEY) {
      headers['Authorization'] = `ApiKey ${ES_API_KEY}`;
    }

    if (type === 'DELETE') {
      const projectId = old_record?.id || record?.id;
      await fetchWithRetry(`${ES_URL}/projects_search/_doc/${projectId}`, { method: 'DELETE', headers });
      return new Response(JSON.stringify({ message: `Deleted project ${projectId}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (type === 'INSERT' || type === 'UPDATE') {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data: project } = await supabase
        .from('projects')
        .select('*')
        .eq('id', record.id)
        .single();

      if (!project) {
        return new Response(JSON.stringify({ message: 'Project not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const [developerRes, imageRes, locationRes, amenityRes] = await Promise.all([
        supabase.from('developers').select('name').eq('id', project.developer_id).maybeSingle(),
        supabase.from('project_images').select('storage_path_original').eq('project_id', project.id)
          .order('is_primary', { ascending: false }).order('id', { ascending: true }).limit(1).maybeSingle(),
        supabase.from('project_locations').select('locations(name)').eq('project_id', project.id)
          .order('level', { referencedTable: 'locations', ascending: false }).limit(1).maybeSingle(),
        supabase.from('project_amenities').select('amenities(name)').eq('project_id', project.id),
      ]);

      const amenities = (amenityRes.data || [])
        .map((a: any) => a.amenities?.name || '')
        .filter(Boolean);

      const doc = {
        id: project.id,
        name: project.name || '',
        slug: project.slug || '',
        description: project.description_html || project.description || '',
        developer_name: developerRes.data?.name || project.builder_name || '',
        low_price: project.low_price || 0,
        high_price: project.high_price || 0,
        sort_price: project.low_price || 0,
        entity_type: 'project',
        status: 'available',
        construction_phase: project.construction_phase || '',
        delivery_date: project.delivery_date || null,
        location_text: locationRes.data?.locations?.name || '',
        location: project.latitude != null && project.longitude != null
          ? { lat: Number(project.latitude), lon: Number(project.longitude) }
          : null,
        amenities,
        image_url: imageRes.data?.storage_path_original || null,
        created_at: project.created_at,
        suggest: [
          project.name?.trim(),
          locationRes.data?.locations?.name?.trim(),
          developerRes.data?.name?.trim(),
        ].filter(Boolean),
      };

      await fetchWithRetry(`${ES_URL}/projects_search/_doc/${project.id}`, {
        method: 'PUT', headers, body: JSON.stringify(doc),
      });

      return new Response(JSON.stringify({ message: `Indexed project ${project.id}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: `Unknown type: ${type}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Project reindex webhook failed:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
