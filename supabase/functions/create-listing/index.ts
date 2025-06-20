// supabase/functions/create-listing/index.ts

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Safer User Authentication Check
    const authHeader = req.headers.get('Authorization')!
    const userResponse = await supabaseAdmin.auth.getUser(authHeader.replace('Bearer ', ''))
    if (userResponse.error) throw userResponse.error
    const user = userResponse.data.user

    const body = await req.json()
    console.log("Received payload:", JSON.stringify(body, null, 2)); // Added for debugging

    const {
      propertyTypeId, commonData, residentialData, commercialData, landData,
      amenities, furnishings, otherRooms, locationAdvantages, coordinates
    } = body

    // 1. Insert into the main properties table
    const { data: property, error: propertyError } = await supabaseAdmin
      .from('properties')
      .insert({
        user_id: user.id,
        property_type_id: Number(propertyTypeId),
        listing_purpose_id: Number(commonData.listing_purpose_id) || null,
        ownership_type_id: Number(commonData.ownership_type_id) || null,
        availability_status_id: Number(commonData.availability_status_id) || null,
        title: commonData.title,
        description: commonData.description,
        price: Number(commonData.price),
        location_text: commonData.location_text,
        location_point: coordinates ? `POINT(${coordinates.lng} ${coordinates.lat})` : null
      })
      .select('id')
      .single()

    if (propertyError) throw propertyError;
    const propertyId = property.id;
    console.log("Created property with ID:", propertyId);

    const insertPromises = [];

    // 2. Conditionally insert into detail tables
    if (propertyTypeId === '1' && residentialData) {
      insertPromises.push(supabaseAdmin.from('details_residential').insert({ property_id: propertyId, ...residentialData }));
    } else if (propertyTypeId === '2' && commercialData) {
      insertPromises.push(supabaseAdmin.from('details_commercial').insert({ property_id: propertyId, ...commercialData }));
    } else if (propertyTypeId === '3' && landData) {
      insertPromises.push(supabaseAdmin.from('details_land').insert({ property_id: propertyId, ...landData }));
    }

    // 3. Insert into junction tables (if arrays are not empty)
    if (amenities?.length > 0) {
      const amenitiesToInsert = amenities.map((id: number) => ({ property_id: propertyId, amenity_id: id }));
      insertPromises.push(supabaseAdmin.from('junction_property_amenities').insert(amenitiesToInsert));
    }
    if (furnishings?.length > 0) {
      const furnishingsToInsert = furnishings.map((id: number) => ({ property_id: propertyId, furnishing_item_id: id }));
      insertPromises.push(supabaseAdmin.from('junction_property_furnishings').insert(furnishingsToInsert));
    }
    if (otherRooms?.length > 0) {
      const roomsToInsert = otherRooms.map((id: number) => ({ property_id: propertyId, room_id: id }));
      insertPromises.push(supabaseAdmin.from('junction_property_other_rooms').insert(roomsToInsert));
    }
    if (locationAdvantages?.length > 0) {
      const advantagesToInsert = locationAdvantages.map((id: number) => ({ property_id: propertyId, advantage_id: id }));
      insertPromises.push(supabaseAdmin.from('junction_property_location_advantages').insert(advantagesToInsert));
    }

    await Promise.all(insertPromises);
    console.log("Successfully inserted all related data.");

    return new Response(JSON.stringify({ propertyId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    console.error("Error in Edge Function:", err); // Better logging
    return new Response(String(err?.message ?? err), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
    })
  }
})