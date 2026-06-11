import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const { type, table, record, old_record } = payload;

    if (table !== 'properties') {
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

    if (type === 'DELETE' || (type === 'UPDATE' && record?.status === 'deleted')) {
      const propertyId = old_record?.id || record?.id;
      await fetch(`${ES_URL}/properties_search/_doc/${propertyId}`, {
        method: 'DELETE',
        headers,
      });
      return new Response(JSON.stringify({ message: `Deleted ${propertyId}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (type === 'INSERT' || type === 'UPDATE') {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data: property } = await supabase
        .from('properties')
        .select('*, ST_Y(location_point::geometry) as latitude, ST_X(location_point::geometry) as longitude')
        .eq('id', record.id)
        .single();

      if (!property) {
        return new Response(JSON.stringify({ message: 'Property not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const [typeRes, purposeRes, profileRes, mediaRes, projectRes] = await Promise.all([
        supabase.from('property_types').select('name').eq('id', property.property_type_id).single(),
        supabase.from('lookup_listing_purposes').select('name').eq('id', property.listing_purpose_id).single(),
        supabase.from('profiles').select('name, phone_number').eq('id', property.user_id).single(),
        supabase.from('property_media').select('media_url').eq('property_id', property.id).order('display_order'),
        supabase.from('projects').select('name, builder_name').eq('id', property.project_id).maybeSingle(),
      ]);

      const doc = {
        id: property.id,
        title: property.title || '',
        description: property.description || '',
        location_text: property.location_text || '',
        location: property.latitude != null && property.longitude != null
          ? { lat: property.latitude, lon: property.longitude } : null,
        price: property.price || 0,
        property_type: typeRes.data?.name || '',
        property_type_id: property.property_type_id,
        listing_purpose: purposeRes.data?.name || '',
        listing_purpose_id: property.listing_purpose_id,
        status: property.status || 'available',
        property_score: property.property_score || 0,
        image_url: mediaRes.data?.[0]?.media_url || null,
        all_images: (mediaRes.data || []).map((m) => m.media_url),
        owner_name: profileRes.data?.name || '',
        owner_phone: profileRes.data?.phone_number || '',
        project_name: projectRes.data?.name || '',
        developer_name: projectRes.data?.builder_name || '',
        is_price_negotiable: property.is_price_negotiable || false,
        created_at: property.created_at,
        updated_at: property.updated_at || property.created_at,
        suggest: [
          property.title?.trim(),
          property.location_text?.trim(),
          projectRes.data?.name?.trim(),
        ].filter(Boolean),
        bathrooms: 0, balconies: 0, area_sqft: 0, area_unit: 'sqft',
        bhk_type: '', bhk_type_id: null, furnishing_status: '',
        amenities: [], furnishings: [], other_rooms: [], location_advantages: [],
        availability_status: '', ownership_type: '',
      };

      await fetch(`${ES_URL}/properties_search/_doc/${property.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(doc),
      });

      return new Response(JSON.stringify({ message: `Indexed ${property.id}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: `Unknown type: ${type}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Reindex webhook error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
