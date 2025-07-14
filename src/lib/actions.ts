// src/lib/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/serverClient';

// --- TYPE DEFINITIONS ---
type CommonFormData = { title: string; description: string; price: string; location_text: string; listing_purpose_id: string; ownership_type_id: string; availability_status_id: string; phone_number: string; };
type ResidentialFormData = { bhk_type_id: string; bathrooms: string; balconies: string; total_floors: string; property_on_floor: string; furnishing_status_id: string; carpet_area: string; built_up_area: string; super_built_up_area: string; };
type CommercialFormData = { commercial_sub_type_id: string; office_type_id: string; min_seats: string; max_seats: string; cabins: string; meeting_rooms: string; private_washrooms: string; shared_washrooms: string; passenger_lifts: string; service_lifts: string; is_pre_leased: boolean; has_noc: boolean; has_occupancy_cert: boolean; carpet_area: string; };
type LandFormData = { plot_area: string; area_unit: string; is_boundary_wall_made: boolean; };
type ExistingImage = { id: number; tag: string; };
type NewImageDbEntry = { media_url: string; tag: string; media_type: string; display_order: number; };

// --- HELPER FUNCTIONS ---
const safeParseInt = (val: string | null | undefined): number | null => {
  if (!val || val.trim() === '') return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
};

const safeParseFloat = (val: string | null | undefined): number | null => {
  if (!val || val.trim() === '') return null;
  const num = parseFloat(val);
  return isNaN(num) ? null : num;
};

// --- LOGGING ACTIONS ---
export async function logPropertyView(propertyId: string) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  try {
    await supabase.from('event_logs').insert({
        property_id: propertyId,
        user_id: user.id,
        event_type: 'property_view'
    }).throwOnError();
  } catch (error) {
    console.error('Error logging property view:', error);
  }
}

export async function logLeadStatusChange(
    leadId: string,
    fromStatus: string,
    toStatus: string
) {
    const supabase = createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    try {
        await supabase.rpc('log_lead_status_change', {
            p_lead_id: leadId,
            p_from_status: fromStatus,
            p_to_status: toStatus,
        }).throwOnError();
    } catch (error) {
        console.error('Unexpected error in logLeadStatusChange:', error);
    }
}

export async function logAction(
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, any>
) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  try {
    await supabase.rpc('log_action', {
      p_action: action,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_metadata: metadata || null,
    }).throwOnError();
  } catch (error) {
    console.error('Unexpected error in logAction server action:', error);
  }
}

// --- CORE SERVER ACTIONS ---
export async function updatePropertyAndManageImages(
  propertyId: string,
  userId: string,
  propertyTypeId: string,
  commonData: CommonFormData,
  residentialData: ResidentialFormData,
  commercialData: CommercialFormData,
  landData: LandFormData,
  imagesToDelete: { id: number; file_path: string }[],
  existingImagesToUpdate: ExistingImage[],
  newImageDbEntries: NewImageDbEntry[],
  selectedAmenities: number[],
  selectedFurnishings: number[],
  selectedOtherRooms: number[],
  selectedLocationAdvantages: number[],
  selectedLandFeatures: number[]
) {
  const supabase = createSupabaseServerClient();

  try {
    // 1. Update user's phone number
    await supabase
        .from('profiles')
        .update({ phone_number: commonData.phone_number })
        .eq('id', userId)
        .throwOnError();

    // 2. Update the main 'properties' table
    await supabase
      .from('properties')
      .update({
        title: commonData.title,
        description: commonData.description,
        price: safeParseFloat(commonData.price),
        location_text: commonData.location_text,
        listing_purpose_id: safeParseInt(commonData.listing_purpose_id),
        ownership_type_id: safeParseInt(commonData.ownership_type_id),
        availability_status_id: safeParseInt(commonData.availability_status_id),
      })
      .eq('id', propertyId)
      .eq('user_id', userId)
      .throwOnError();

    // 3. Conditionally update details tables
    if (propertyTypeId === '1') { // Residential
        await supabase.from('details_residential').update({
            bhk_type_id: safeParseInt(residentialData.bhk_type_id),
            bathrooms: safeParseInt(residentialData.bathrooms),
            balconies: safeParseInt(residentialData.balconies),
            total_floors: safeParseInt(residentialData.total_floors),
            property_on_floor: safeParseInt(residentialData.property_on_floor),
            furnishing_status_id: safeParseInt(residentialData.furnishing_status_id),
            carpet_area: safeParseFloat(residentialData.carpet_area),
            built_up_area: safeParseFloat(residentialData.built_up_area),
            super_built_up_area: safeParseFloat(residentialData.super_built_up_area),
        }).eq('property_id', propertyId).throwOnError();
    } else if (propertyTypeId === '2') { // Commercial
        await supabase.from('details_commercial').update({
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
            is_pre_leased: commercialData.is_pre_leased,
            has_noc: commercialData.has_noc,
            has_occupancy_cert: commercialData.has_occupancy_cert,
            carpet_area: safeParseFloat(commercialData.carpet_area),
        }).eq('property_id', propertyId).throwOnError();
    } else if (propertyTypeId === '3') { // Land
        await supabase.from('details_land').update({
            plot_area: safeParseFloat(landData.plot_area),
            area_unit: landData.area_unit,
            is_boundary_wall_made: landData.is_boundary_wall_made,
        }).eq('property_id', propertyId).throwOnError();
    }

    // 4. Update junction tables by deleting old and inserting new
    const junctionTables = [
        { table: 'junction_property_amenities', column: 'amenity_id', data: selectedAmenities },
        { table: 'junction_property_furnishings', column: 'furnishing_item_id', data: selectedFurnishings },
        { table: 'junction_property_other_rooms', column: 'room_id', data: selectedOtherRooms },
        { table: 'junction_property_location_advantages', column: 'advantage_id', data: selectedLocationAdvantages },
        { table: 'junction_property_land_features', column: 'feature_id', data: selectedLandFeatures },
    ];

    for (const { table, column, data } of junctionTables) {
        await supabase.from(table).delete().eq('property_id', propertyId).throwOnError();
        if (data.length > 0) {
            const records = data.map(id => ({ property_id: propertyId, [column]: id }));
            await supabase.from(table).insert(records).throwOnError();
        }
    }

    // 5. Handle image deletions, updates, and additions
    if (imagesToDelete.length > 0) {
        await supabase.from('property_media').delete().in('id', imagesToDelete.map(img => img.id)).throwOnError();
        await supabase.storage.from('property-images').remove(imagesToDelete.map(img => img.file_path));
    }
    for (const img of existingImagesToUpdate) {
        await supabase.from('property_media').update({ tag: img.tag }).eq('id', img.id).throwOnError();
    }
    if (newImageDbEntries.length > 0) {
        const entriesWithPropertyId = newImageDbEntries.map(entry => ({ ...entry, property_id: propertyId }));
        await supabase.from('property_media').insert(entriesWithPropertyId).throwOnError();
    }

    // 6. Log the successful update action
    await logAction('update_property', 'property', propertyId);

    // 7. Revalidate paths
    revalidatePath(`/property/${propertyId}`);
    revalidatePath('/my-listings');
    revalidatePath(`/edit-property/${propertyId}`);

    return { success: true, message: 'Property updated successfully!' };
  } catch (error: any) {
    console.error('Server Action Critical Error:', error);
    return { success: false, message: `An unexpected error occurred: ${error.message}` };
  }
}
