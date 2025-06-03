// src/lib/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/serverClient';

type PropertyUpdatePayload = {
  title: string;
  description: string;
  price: number;
  bhk_type_id: number;
  listing_type_id: number;
  property_type_id: number;
  area_sqft: number;
  location_text: string;
};

type NewImageDbEntry = {
  property_id: string;
  image_url: string;
};

export async function updatePropertyAndManageImages(
  propertyId: string,
  userId: string,
  formData: PropertyUpdatePayload,
  imagePathsToDelete: string[], // Paths of images to delete from storage
  imageIdsToDelete: number[],    // IDs of images to delete from DB metadata
  newImageDbEntries: NewImageDbEntry[],
) {
  const supabase = createSupabaseServerClient();

  console.log('--- Server Action: updatePropertyAndManageImages Called ---');
  console.log('Property ID:', propertyId);
  console.log('User ID:', userId);
  console.log('FormData:', formData);
  console.log('Image Paths to Delete (from storage):', imagePathsToDelete);
  console.log('Image IDs to Delete (from DB metadata):', imageIdsToDelete);
  console.log('New Image DB Entries (metadata to insert):', newImageDbEntries);
  console.log('---------------------------------------------------------');

  try {
    // 1. Update main property details in the database
    const { error: propertyUpdateError } = await supabase
      .from('properties')
      .update(formData)
      .eq('id', propertyId)
      .eq('user_id', userId);

    if (propertyUpdateError) {
      console.error('Server Action Error: Failed to update property details:', propertyUpdateError);
      return { success: false, message: `Failed to update property details: ${propertyUpdateError.message}` };
    }
    console.log('Server Action: Property details updated successfully.');


    // 2. Handle image deletions: Delete actual files from Storage and then their metadata from the DB
    if (imagePathsToDelete.length > 0) {
      console.log(`Server Action: Attempting to delete ${imagePathsToDelete.length} images from storage.`);
      const { error: storageDeleteError } = await supabase.storage
        .from('property-images')
        .remove(imagePathsToDelete);
      if (storageDeleteError) {
        console.error('Server Action Error: Error deleting images from storage:', storageDeleteError);
        // Continue to DB deletion even if storage fails
      } else {
        console.log('Server Action: Images successfully removed from storage (or no error reported).');
      }

      console.log(`Server Action: Attempting to delete ${imageIdsToDelete.length} image metadata records from DB with IDs:`, imageIdsToDelete);
      // FIX: Removed .select('count') from the delete query
      const { error: dbDeleteError, count } = await supabase
        .from('property_images')
        .delete()
        .in('id', imageIdsToDelete);

      if (dbDeleteError) {
        console.error('Server Action Error: Error deleting image metadata from DB:', dbDeleteError);
        return { success: false, message: `Failed to delete image metadata: ${dbDeleteError.message}` };
      }
      // Supabase delete() now returns { data: null, error: null, count: number } on success
      console.log(`Server Action: Successfully deleted ${count} image metadata records from DB.`);
      if (count === 0 && imageIdsToDelete.length > 0) {
          console.warn('Server Action Warning: No image metadata records were deleted from DB, but IDs were provided. Check RLS for public.property_images DELETE policy or provided IDs.');
      }
    } else {
      console.log('Server Action: No images marked for deletion.');
    }


    // 3. Handle new image uploads: Insert metadata into the DB (files are already in storage)
    if (newImageDbEntries.length > 0) {
      console.log(`Server Action: Attempting to insert ${newImageDbEntries.length} new image metadata records.`);
      const { error: imageInsertError } = await supabase
        .from('property_images')
        .insert(newImageDbEntries);
      if (imageInsertError) {
        console.error('Server Action Error: Error inserting new image URLs into DB:', imageInsertError);
        return { success: false, message: `Failed to save new image records: ${imageInsertError.message}` };
      }
      console.log('Server Action: New image metadata inserted into DB successfully.');
    } else {
      console.log('Server Action: No new images to upload.');
    }


    // 4. Revalidate cache for affected pages
    const timestamp = Date.now();
    revalidatePath(`/property/${propertyId}?v=${timestamp}`);
    revalidatePath(`/my-listings?v=${timestamp}`);
    console.log(`Server Action: Revalidated paths with cache-buster: /property/${propertyId}?v=${timestamp} and /my-listings?v=${timestamp}`);

    console.log('--- Server Action: Update completed successfully ---');
    return { success: true, message: 'Property and images updated successfully!' };

  } catch (error: any) {
    console.error('Server Action Critical Error: An unexpected error occurred during update:', error);
    return { success: false, message: `An unexpected error occurred: ${error.message}` };
  }
}
