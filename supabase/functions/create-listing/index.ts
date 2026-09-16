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

    // 3. Conditionally insert into property detail tables.
    // Form state sends '' for every unfilled field — raw spreads fail with
    // `invalid input syntax for type integer: ""` AFTER the property row was
    // already inserted (orphan property, no details). Parse everything.
    const detailPromises = [];
    if (propertyTypeId === '1' && residentialData) {
        const r = residentialData as Record<string, unknown>;
        detailPromises.push(supabaseAdmin.from('details_residential').insert({
            property_id: propertyId,
            bhk_type_id: safeParseInt(r.bhk_type_id as string | undefined),
            bathrooms: safeParseInt(r.bathrooms as string | undefined),
            balconies: safeParseInt(r.balconies as string | undefined),
            total_floors: safeParseInt(r.total_floors as string | undefined),
            property_on_floor: safeParseInt(r.property_on_floor as string | undefined),
            furnishing_status_id: safeParseInt(r.furnishing_status_id as string | undefined),
            carpet_area: safeParseFloat(r.carpet_area as string | undefined),
            built_up_area: safeParseFloat(r.built_up_area as string | undefined),
            super_built_up_area: safeParseFloat(r.super_built_up_area as string | undefined),
        }));
    } else if (propertyTypeId === '2' && commercialData) {
        const c = commercialData as Record<string, unknown>;
        detailPromises.push(supabaseAdmin.from('details_commercial').insert({
            property_id: propertyId,
            commercial_sub_type_id: safeParseInt(c.commercial_sub_type_id as string | undefined),
            office_type_id: safeParseInt(c.office_type_id as string | undefined),
            min_seats: safeParseInt(c.min_seats as string | undefined),
            max_seats: safeParseInt(c.max_seats as string | undefined),
            cabins: safeParseInt(c.cabins as string | undefined),
            meeting_rooms: safeParseInt(c.meeting_rooms as string | undefined),
            private_washrooms: safeParseInt(c.private_washrooms as string | undefined),
            shared_washrooms: safeParseInt(c.shared_washrooms as string | undefined),
            passenger_lifts: safeParseInt(c.passenger_lifts as string | undefined),
            service_lifts: safeParseInt(c.service_lifts as string | undefined),
            total_floors: safeParseInt(c.total_floors as string | undefined),
            property_on_floor: safeParseInt(c.property_on_floor as string | undefined),
            carpet_area: safeParseFloat(c.carpet_area as string | undefined),
            is_pre_leased: Boolean(c.is_pre_leased),
            has_noc: Boolean(c.has_noc),
            has_occupancy_cert: Boolean(c.has_occupancy_cert),
        }));
    } else if (propertyTypeId === '3' && landData) {
        const l = landData as Record<string, unknown>;
        detailPromises.push(supabaseAdmin.from('details_land').insert({
            property_id: propertyId,
            plot_area: safeParseFloat(l.plot_area as string | undefined),
            area_unit: (l.area_unit as string) || 'sqft',
            is_boundary_wall_made: Boolean(l.is_boundary_wall_made),
        }));
    }

    const detailResults = await Promise.all(detailPromises);
    for (const res of detailResults) {
        if ((res as { error?: { message?: string } }).error) {
            throw new Error(`Details insert failed: ${(res as { error: { message: string } }).error.message}`);
        }
    }

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
    
    const junctionResults = await Promise.all(junctionPromises);
    for (const res of junctionResults) {
        if ((res as { error?: { message?: string } }).error) {
            throw new Error(`Relation insert failed: ${(res as { error: { message: string } }).error.message}`);
        }
    }

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
