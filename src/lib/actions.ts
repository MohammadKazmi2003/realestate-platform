// src/lib/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/serverClient';

// --- TYPE DEFINITIONS TO MATCH THE FORM STATE ---
type CommonFormData = { title: string; description: string; price: string; location_text: string; listing_purpose_id: string; ownership_type_id: string; availability_status_id: string; };
type ResidentialFormData = { bhk_type_id: string; bathrooms: string; balconies: string; total_floors: string; property_on_floor: string; furnishing_status_id: string; carpet_area: string; built_up_area: string; super_built_up_area: string; };
type CommercialFormData = { commercial_sub_type_id: string; office_type_id: string; min_seats: string; max_seats: string; cabins: string; meeting_rooms: string; private_washrooms: string; shared_washrooms: string; passenger_lifts: string; service_lifts: string; is_pre_leased: boolean; has_noc: boolean; has_occupancy_cert: boolean; carpet_area: string; };
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

// --- THE COMPLETE SERVER ACTION ---
export async function updatePropertyAndManageImages(
  propertyId: string,
  userId: string,
  propertyTypeId: string,
  commonData: CommonFormData,
  residentialData: ResidentialFormData,
  commercialData: CommercialFormData,
  imagesToDelete: { id: number; file_path: string }[],
  newImageDbEntries: NewImageDbEntry[],
) {
  const supabase = createSupabaseServerClient();

  try {
    // TRANSACTION: In a real-world scenario, you would wrap these operations in a transaction
    // using a database function (RPC) to ensure that if one step fails, all steps are rolled back.
    // For simplicity with server actions, we perform them sequentially and handle errors at each step.

    // 1. Update the main 'properties' table
    const { error: propertyUpdateError } = await supabase
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
      .eq('user_id', userId);

    if (propertyUpdateError) throw propertyUpdateError;

    // 2. Conditionally update the 'details' tables based on property type
    if (propertyTypeId === '1') { // Residential
        const { error: resError } = await supabase.from('details_residential').update({
            bhk_type_id: safeParseInt(residentialData.bhk_type_id),
            bathrooms: safeParseInt(residentialData.bathrooms),
            balconies: safeParseInt(residentialData.balconies),
            total_floors: safeParseInt(residentialData.total_floors),
            property_on_floor: safeParseInt(residentialData.property_on_floor),
            furnishing_status_id: safeParseInt(residentialData.furnishing_status_id),
            carpet_area: safeParseFloat(residentialData.carpet_area),
            built_up_area: safeParseFloat(residentialData.built_up_area),
            super_built_up_area: safeParseFloat(residentialData.super_built_up_area),
        }).eq('property_id', propertyId);
        if (resError) console.warn("Warning: Could not update residential details:", resError.message);
    } else if (propertyTypeId === '2') { // Commercial
        const { error: commError } = await supabase.from('details_commercial').update({
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
        }).eq('property_id', propertyId);
        if (commError) console.warn("Warning: Could not update commercial details:", commError.message);
    }
    // No action needed for Land/Plot (type '3') as it has no details table yet.

    // 3. Handle image deletions from Storage and DB
    if (imagesToDelete.length > 0) {
      const imagePathsToDelete = imagesToDelete.map(img => img.file_path).filter(Boolean);
      const imageIdsToDelete = imagesToDelete.map(img => img.id);
      if (imagePathsToDelete.length > 0) {
        await supabase.storage.from('property-images').remove(imagePathsToDelete);
      }
      if (imageIdsToDelete.length > 0) {
        await supabase.from('property_media').delete().in('id', imageIdsToDelete);
      }
    }

    // 4. Insert new image metadata into the DB
    if (newImageDbEntries.length > 0) {
      const entriesToInsert = newImageDbEntries.map(entry => ({
        ...entry,
        property_id: propertyId,
      }));
      const { error: imageInsertError } = await supabase.from('property_media').insert(entriesToInsert);
      if (imageInsertError) throw imageInsertError;
    }

    // 5. Revalidate Next.js cache to show updated data immediately
    revalidatePath(`/property/${propertyId}`);
    revalidatePath('/my-listings');
    revalidatePath(`/edit-property/${propertyId}`);

    return { success: true, message: 'Property updated successfully!' };

  } catch (error: any) {
    console.error('Server Action Critical Error:', error);
    return { success: false, message: `An unexpected error occurred: ${error.message}` };
  }
}
