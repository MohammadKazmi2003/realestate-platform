// supabase/functions/create-listing/index.ts

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper functions to safely parse form values
const safeParseInt = (val: string | number | undefined): number | null => {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = parseInt(val, 10);
    return isNaN(num) ? null : num;
  }
  return null;
};

const safeParseFloat = (val: string | number | undefined): number | null => {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = parseFloat(val);
    return isNaN(num) ? null : num;
  }
  return null;
};

// Main server logic
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Initialize Admin Client & Authenticate User
    const supabaseAdmin: SupabaseClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        throw new Error('Missing Authorization header');
    }
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userError || !user) throw userError || new Error("User not found");

    const body = await req.json();
    const {
      propertyTypeId, commonData, residentialData, commercialData, landData,
      amenities, furnishings, otherRooms, locationAdvantages, landFeatures,
      coordinates,
    } = body;

    // Update phone number on the user's profile
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .update({ phone_number: commonData.phone_number })
      .eq('id', user.id);

    if (profileError) throw profileError;

    // 2. Insert into the main 'properties' table
    const { data: property, error: propertyError } = await supabaseAdmin
      .from('properties')
      .insert({
        user_id: user.id,
        property_type_id: Number(propertyTypeId),
        listing_purpose_id: safeParseInt(commonData.listing_purpose_id),
        ownership_type_id: safeParseInt(commonData.ownership_type_id),
        availability_status_id: safeParseInt(commonData.availability_status_id),
        title: commonData.title,
        description: commonData.description,
        price: safeParseFloat(commonData.price),
        location_text: commonData.location_text,
        location_point: coordinates ? `POINT(${coordinates.lng} ${coordinates.lat})` : null,
      })
      .select('id')
      .single();

    if (propertyError) throw propertyError;
    const propertyId = property.id;

    // 3. Conditionally insert into property detail tables
    const detailPromises = [];
    if (propertyTypeId === '1' && residentialData) {
        detailPromises.push(supabaseAdmin.from('details_residential').insert({ property_id: propertyId, ...residentialData }));
    } else if (propertyTypeId === '2' && commercialData) {
        detailPromises.push(supabaseAdmin.from('details_commercial').insert({ property_id: propertyId, ...commercialData }));
    } else if (propertyTypeId === '3' && landData) {
        detailPromises.push(supabaseAdmin.from('details_land').insert({ property_id: propertyId, ...landData }));
    }

    await Promise.all(detailPromises);

    // 4. Concurrently insert into all relevant junction tables
    const junctionPromises = [];

    if (amenities?.length > 0) {
      junctionPromises.push(supabaseAdmin.from('junction_property_amenities').insert(amenities.map((id: number) => ({ property_id: propertyId, amenity_id: id }))));
    }
    if (furnishings?.length > 0) {
      junctionPromises.push(supabaseAdmin.from('junction_property_furnishings').insert(furnishings.map((id: number) => ({ property_id: propertyId, furnishing_item_id: id }))));
    }
    if (otherRooms?.length > 0) {
      junctionPromises.push(supabaseAdmin.from('junction_property_other_rooms').insert(otherRooms.map((id: number) => ({ property_id: propertyId, room_id: id }))));
    }
    if (locationAdvantages?.length > 0) {
      junctionPromises.push(supabaseAdmin.from('junction_property_location_advantages').insert(locationAdvantages.map((id: number) => ({ property_id: propertyId, advantage_id: id }))));
    }
    if (landFeatures?.length > 0) {
        junctionPromises.push(supabaseAdmin.from('junction_property_land_features').insert(landFeatures.map((id: number) => ({ property_id: propertyId, feature_id: id }))));
    }
    
    await Promise.all(junctionPromises);

    // 5. Return a successful response
    return new Response(JSON.stringify({ propertyId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (err) {
    console.error("Error in Edge Function:", err);
    return new Response(JSON.stringify({ error: { message: err.message, stack: err.stack } }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
