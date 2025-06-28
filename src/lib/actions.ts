// src/lib/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/serverClient';

// --- TYPE DEFINITIONS TO MATCH THE FORM STATE ---
type CommonFormData = { title: string; description: string; price: string; location_text: string; listing_purpose_id: string; ownership_type_id: string; availability_status_id: string; phone_number: string; }; // ADDED phone_number
type ResidentialFormData = { bhk_type_id: string; bathrooms: string; balconies: string; total_floors: string; property_on_floor: string; furnishing_status_id: string; carpet_area: string; built_up_area: string; super_built_up_area: string; };
type CommercialFormData = { commercial_sub_type_id: string; office_type_id: string; min_seats: string; max_seats: string; cabins: string; meeting_rooms: string; private_washrooms: string; shared_washrooms: string; passenger_lifts: string; service_lifts: string; is_pre_leased: boolean; has_noc: boolean; has_occupancy_cert: boolean; carpet_area: string; };
type LandFormData = { plot_area: string; area_unit: string; is_boundary_wall_made: boolean; }; // ADDED
type ExistingImage = { id: number; tag: string; }; // ADDED
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
  landData: LandFormData, // ADDED
  imagesToDelete: { id: number; file_path: string }[],
  existingImagesToUpdate: ExistingImage[], // ADDED
  newImageDbEntries: NewImageDbEntry[],
) {
  const supabase = createSupabaseServerClient();

  try {
    // --- TRANSACTION-LIKE OPERATIONS ---
    
    // 1. Update the user's phone number in the 'profiles' table
    const { error: profileUpdateError } = await supabase
        .from('profiles')
        .update({ phone_number: commonData.phone_number })
        .eq('id', userId);

    if (profileUpdateError) throw profileUpdateError;

    // 2. Update the main 'properties' table
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

    // 3. Conditionally update the 'details' tables based on property type
    if (propertyTypeId === '1') {
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
    } else if (propertyTypeId === '2') {
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
    } else if (propertyTypeId === '3') { // ADDED: Land details update
        const { error: landError } = await supabase.from('details_land').update({
            plot_area: safeParseFloat(landData.plot_area),
            area_unit: landData.area_unit,
            is_boundary_wall_made: landData.is_boundary_wall_made,
        }).eq('property_id', propertyId);
        if (landError) console.warn("Warning: Could not update land details:", landError.message);
    }

    // 4. Handle image deletions from Storage and DB
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
    
    // 5. Handle updates to existing image tags
    if (existingImagesToUpdate.length > 0) {
        const updates = existingImagesToUpdate.map(img => 
            supabase.from('property_media').update({ tag: img.tag }).eq('id', img.id)
        );
        await Promise.all(updates);
    }

    // 6. Insert new image metadata into the DB
    if (newImageDbEntries.length > 0) {
      const entriesToInsert = newImageDbEntries.map(entry => ({
        ...entry,
        property_id: propertyId,
      }));
      const { error: imageInsertError } = await supabase.from('property_media').insert(entriesToInsert);
      if (imageInsertError) throw imageInsertError;
    }

    // 7. Revalidate Next.js cache to show updated data immediately
    revalidatePath(`/property/${propertyId}`);
    revalidatePath('/my-listings');
    revalidatePath(`/edit-property/${propertyId}`);

    return { success: true, message: 'Property updated successfully!' };

  } catch (error: any) {
    console.error('Server Action Critical Error:', error);
    return { success: false, message: `An unexpected error occurred: ${error.message}` };
  }
}
