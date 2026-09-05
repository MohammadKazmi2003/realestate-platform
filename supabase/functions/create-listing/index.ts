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
    // Resolve parent category so subtype IDs (4=Res Apartment, 5=House/Villa,
    // 6=Comm Office, 7=Comm Retail) map to the correct details table.
    // Previously hardcoded '1'/'2'/'3' silently dropped details for subtypes.
    const { data: typeRow } = await supabaseAdmin
      .from('property_types')
      .select('id, name, parent_id')
      .eq('id', Number(propertyTypeId))
      .single();
    let rootId: number | null = typeRow?.parent_id ?? typeRow?.id ?? null;
    // Follow one more level in case of deeper nesting
    if (typeRow?.parent_id != null) {
      const { data: parentRow } = await supabaseAdmin
        .from('property_types')
        .select('id, parent_id')
        .eq('id', typeRow.parent_id)
        .single();
      if (parentRow?.parent_id != null) rootId = parentRow.parent_id;
      else if (parentRow?.id != null) rootId = parentRow.id;
    }
    const rootName: string | null = (() => {
      // Fast path for known IDs without extra query
      if (String(propertyTypeId) === '1' || String(propertyTypeId) === '4' || String(propertyTypeId) === '5') return 'Residential';
      if (String(propertyTypeId) === '2' || String(propertyTypeId) === '6' || String(propertyTypeId) === '7') return 'Commercial';
      if (String(propertyTypeId) === '3') return 'Land / Plot';
      return typeRow?.name ?? null;
    })();
    const isResidential = rootId === 1 || rootName === 'Residential';
    const isCommercial = rootId === 2 || rootName === 'Commercial';
    const isLand = rootId === 3 || rootName === 'Land / Plot';

    const detailPromises = [];
    const cleanResidential = residentialData ? {
      property_id: propertyId,
      bhk_type_id: safeParseInt(residentialData.bhk_type_id),
      bathrooms: safeParseInt(residentialData.bathrooms),
      balconies: safeParseInt(residentialData.balconies),
      total_floors: safeParseInt(residentialData.total_floors),
      property_on_floor: safeParseInt(residentialData.property_on_floor),
      furnishing_status_id: safeParseInt((residentialData as any).furnishing_status_id),
      carpet_area: safeParseFloat((residentialData as any).carpet_area),
      built_up_area: safeParseFloat((residentialData as any).built_up_area),
      super_built_up_area: safeParseFloat((residentialData as any).super_built_up_area),
    } : null;
    const cleanCommercial = commercialData ? {
      property_id: propertyId,
      commercial_sub_type_id: safeParseInt((commercialData as any).commercial_sub_type_id),
      office_type_id: safeParseInt((commercialData as any).office_type_id),
      min_seats: safeParseInt((commercialData as any).min_seats),
      max_seats: safeParseInt((commercialData as any).max_seats),
      cabins: safeParseInt((commercialData as any).cabins),
      meeting_rooms: safeParseInt((commercialData as any).meeting_rooms),
      private_washrooms: safeParseInt((commercialData as any).private_washrooms),
      shared_washrooms: safeParseInt((commercialData as any).shared_washrooms),
      passenger_lifts: safeParseInt((commercialData as any).passenger_lifts),
      service_lifts: safeParseInt((commercialData as any).service_lifts),
      is_pre_leased: !!(commercialData as any).is_pre_leased,
      has_noc: !!(commercialData as any).has_noc,
      has_occupancy_cert: !!(commercialData as any).has_occupancy_cert,
      carpet_area: safeParseFloat((commercialData as any).carpet_area),
      total_floors: safeParseInt((commercialData as any).total_floors),
      property_on_floor: safeParseInt((commercialData as any).property_on_floor),
      // furnishing_status_id added via migration 20260906; passthrough when present
      ...(((commercialData as any).furnishing_status_id !== undefined && (commercialData as any).furnishing_status_id !== '' && (commercialData as any).furnishing_status_id !== null) ? { furnishing_status_id: safeParseInt((commercialData as any).furnishing_status_id) } : {}),
    } : null;
    const cleanLand = landData ? {
      property_id: propertyId,
      plot_area: safeParseFloat((landData as any).plot_area),
      area_unit: (landData as any).area_unit || 'sqft',
      is_boundary_wall_made: !!(landData as any).is_boundary_wall_made,
    } : null;
    if (isResidential && cleanResidential) {
        detailPromises.push(supabaseAdmin.from('details_residential').insert(cleanResidential));
    } else if (isCommercial && cleanCommercial) {
        detailPromises.push(supabaseAdmin.from('details_commercial').insert(cleanCommercial));
    } else if (isLand && cleanLand) {
        detailPromises.push(supabaseAdmin.from('details_land').insert(cleanLand));
    } else {
        console.warn(`create-listing: unresolvable propertyTypeId=${propertyTypeId} rootId=${rootId} rootName=${rootName}; details NOT saved`);
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
