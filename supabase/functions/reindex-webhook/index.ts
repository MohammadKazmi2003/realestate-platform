import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function parseWKBPoint(wkbHex: string): { latitude: number | null; longitude: number | null } {
  if (!wkbHex) return { latitude: null, longitude: null };
  try {
    const hex = wkbHex.trim();
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    if (bytes.length >= 25) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const lng = view.getFloat64(9, true);
      const lat = view.getFloat64(17, true);
      return { latitude: lat, longitude: lng };
    }
  } catch {
    console.error('WKB parse error:', wkbHex?.slice(0, 20));
  }
  return { latitude: null, longitude: null };
}

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
      await fetchWithRetry(`${ES_URL}/properties_search/_doc/${propertyId}`, { method: 'DELETE', headers });
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
        .select('*')
        .eq('id', record.id)
        .single();

      if (!property) {
        return new Response(JSON.stringify({ message: 'Property not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const coords = parseWKBPoint(property.location_point);

      const [typeRes, purposeRes, profileRes, mediaRes, projectRes, residentialRes, commercialRes, landRes, amenitiesRes, furnishingsRes] = await Promise.all([
        supabase.from('property_types').select('name').eq('id', property.property_type_id).single(),
        supabase.from('lookup_listing_purposes').select('name').eq('id', property.listing_purpose_id).single(),
        supabase.from('profiles').select('name, phone_number').eq('id', property.user_id).single(),
        supabase.from('property_media').select('media_url').eq('property_id', property.id).order('display_order'),
        supabase.from('projects').select('name, builder_name').eq('id', property.project_id).maybeSingle(),
        supabase.from('details_residential').select('*, bhk_types(label), lookup_furnishing_statuses(name)').eq('property_id', property.id).maybeSingle(),
        supabase.from('details_commercial').select('*, lookup_furnishing_statuses(name)').eq('property_id', property.id).maybeSingle(),
        supabase.from('details_land').select('*').eq('property_id', property.id).maybeSingle(),
        supabase.from('junction_property_amenities').select('amenity_id, lookup_amenities(name)').eq('property_id', property.id),
        supabase.from('junction_property_furnishings').select('furnishing_item_id, lookup_furnishing_items(name)').eq('property_id', property.id),
      ]);
      const resData: any = (residentialRes as any)?.data || null;
      const comData: any = (commercialRes as any)?.data || null;
      const landData: any = (landRes as any)?.data || null;
      const bhkLabel: string = resData?.bhk_types?.label || '';
      const bedrooms: number | null = (() => {
        if (!bhkLabel) return null;
        if (/^studio/i.test(bhkLabel.trim())) return 0;
        const m = bhkLabel.match(/(\d+(\.\d+)?)/);
        return m ? Math.floor(parseFloat(m[1])) : null;
      })();
      const areaSqft: number = (landData?.plot_area ?? resData?.carpet_area ?? resData?.built_up_area ?? resData?.super_built_up_area ?? comData?.carpet_area ?? 0) as number;
      const furnishingStatus: string = resData?.lookup_furnishing_statuses?.name || (comData as any)?.lookup_furnishing_statuses?.name || '';

      const doc = {
        id: property.id,
        title: property.title || '',
        description: property.description || '',
        location_text: property.location_text || '',
        location: coords.latitude != null && coords.longitude != null
          ? { lat: coords.latitude, lon: coords.longitude } : null,
        price: property.price || 0,
        sort_price: property.price || 0,
        entity_type: 'property',
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
        suggest: [property.title?.trim(), property.location_text?.trim(), projectRes.data?.name?.trim()].filter(Boolean),
        bathrooms: resData?.bathrooms ?? 0, balconies: resData?.balconies ?? 0, area_sqft: areaSqft, area_unit: landData?.area_unit || 'sqft',
        bhk_type: bhkLabel, bhk_type_id: resData?.bhk_type_id ?? null, bedrooms, furnishing_status: furnishingStatus,
        cabins: comData?.cabins ?? 0, workstations: comData?.workstations ?? comData?.max_seats ?? 0, min_seats: comData?.min_seats ?? 0, max_seats: comData?.max_seats ?? 0,
        amenities: ((amenitiesRes as any)?.data || []).map((a: any) => a.lookup_amenities?.name || '').filter(Boolean),
        furnishings: ((furnishingsRes as any)?.data || []).map((f: any) => f.lookup_furnishing_items?.name || '').filter(Boolean),
        other_rooms: [], location_advantages: [],
        availability_status: '', ownership_type: '',
      };

      await fetchWithRetry(`${ES_URL}/properties_search/_doc/${property.id}`, {
        method: 'PUT', headers, body: JSON.stringify(doc),
      });

      return new Response(JSON.stringify({ message: `Indexed ${property.id}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: `Unknown type: ${type}` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Reindex webhook failed permanently:', error.message);
    // Dead-letter: log failed reindex to event_logs so it can be replayed
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      const payload = await req.clone().json().catch(() => ({}));
      await supabase.from('event_logs').insert({
        property_id: payload?.record?.id || null,
        event_type: 'reindex_failure',
        user_id: null,
      });
    } catch {}
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
