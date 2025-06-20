// supabase/functions/create-listing/index.ts

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper functions to safely parse form values
const safeParseInt = (val: string | number) => {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = parseInt(val, 10);
    return isNaN(num) ? null : num;
  }
  return null;
};

const safeParseFloat = (val: string | number) => {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const num = parseFloat(val);
    return isNaN(num) ? null : num;
  }
  return null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Initialize Admin Client & Authenticate User
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const authHeader = req.headers.get('Authorization')!;
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userError) throw userError;

    const body = await req.json();
    const {
      propertyTypeId, commonData, residentialData, commercialData, landData,
      amenities, furnishings, otherRooms, locationAdvantages, coordinates,
    } = body;

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
        detailPromises.push(supabaseAdmin.from('details_residential').insert({
            property_id: propertyId,
            bhk_type_id: safeParseInt(residentialData.bhk_type_id),
            bathrooms: safeParseInt(residentialData.bathrooms),
            balconies: safeParseInt(residentialData.balconies),
            total_floors: safeParseInt(residentialData.total_floors),
            property_on_floor: safeParseInt(residentialData.property_on_floor),
            furnishing_status_id: safeParseInt(residentialData.furnishing_status_id),
            carpet_area: safeParseFloat(residentialData.carpet_area),
            built_up_area: safeParseFloat(residentialData.built_up_area),
            super_built_up_area: safeParseFloat(residentialData.super_built_up_area),
        }));
    } else if (propertyTypeId === '2' && commercialData) {
        detailPromises.push(supabaseAdmin.from('details_commercial').insert({
            property_id: propertyId,
            commercial_sub_type_id: safeParseInt(commercialData.commercial_sub_type_id),
            office_type_id: safeParseInt(commercialData.office_type_id),
            min_seats: safeParseInt(commercialData.min_seats),
            max_seats: safeParseInt(commercialData.max_seats),
            cabins: safeParseInt(commercialData.cabins),
            meeting_rooms: safeParseInt(commercialData.meeting_rooms),
            private_washrooms: safeParseInt(commercialData.private_washrooms),
            shared_washrooms: safeParseInt(commercialData.shared_washrooms),
            passenger_lifts: safeParseInt(commercialData.passenger_lifts),
            service_lifts: safeParseInt(commercialData.service_lifts),
            carpet_area: safeParseFloat(commercialData.carpet_area),
            is_pre_leased: commercialData.is_pre_leased,
            has_noc: commercialData.has_noc,
            has_occupancy_cert: commercialData.has_occupancy_cert,
        }));
    }
    await Promise.all(detailPromises);

    // 4. Concurrently insert into all relevant junction tables
    const junctionPromises = [];

    if (amenities && amenities.length > 0) {
      const amenitiesToInsert = amenities.map((id: number) => ({ property_id: propertyId, amenity_id: id }));
      junctionPromises.push(supabaseAdmin.from('junction_property_amenities').insert(amenitiesToInsert));
    }

    if (furnishings && furnishings.length > 0) {
      const furnishingsToInsert = furnishings.map((id: number) => ({ property_id: propertyId, furnishing_item_id: id }));
      junctionPromises.push(supabaseAdmin.from('junction_property_furnishings').insert(furnishingsToInsert));
    }

    if (otherRooms && otherRooms.length > 0) {
      const roomsToInsert = otherRooms.map((id: number) => ({ property_id: propertyId, room_id: id }));
      junctionPromises.push(supabaseAdmin.from('junction_property_other_rooms').insert(roomsToInsert));
    }

    if (locationAdvantages && locationAdvantages.length > 0) {
      const advantagesToInsert = locationAdvantages.map((id: number) => ({ property_id: propertyId, advantage_id: id }));
      junctionPromises.push(supabaseAdmin.from('junction_property_location_advantages').insert(advantagesToInsert));
    }

    await Promise.all(junctionPromises);

    // 5. Return a successful response
    return new Response(JSON.stringify({ propertyId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (err) {
    console.error("Error in Edge Function:", err);
    return new Response(JSON.stringify(err), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});