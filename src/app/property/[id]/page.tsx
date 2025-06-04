// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic'; // Ensures dynamic rendering at request time

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";
import { unstable_noStore as noStore } from 'next/cache';

interface Props {
  params: { id: string };
}

// Types remain the same
export type PropertyDataType = {
  id: string;
  title: string | null;
  description: string | null;
  price: number | null;
  area: number | null; // Assuming this is area_sqft from DB
  location_text: string | null;
  created_at: string | null;
  bhk_types: { label: string | null } | null;
  listing_types: { name: string | null } | null;
  property_types: { name: string | null } | null;
};

export type FlattenedProperty = {
  id: string;
  title: string;
  description: string;
  price: number;
  area: number;
  location_text: string;
  created_at: string;
  bhk_type: string;
  listing_type: string;
  property_type: string;
};

export type ImageType = {
  id: number;
  image_url: string | null; // This will be the original URL from Supabase
};

export default async function PropertyPage({ params }: Props) {
  noStore(); // Opt out of data caching for this route segment

  const supabase = createSupabaseServerClient();

  console.log(`PropertyPage Server Component: Fetching property ID ${params.id}`);

  const { data: propertyData, error: propertyError } = await supabase
    .from("properties")
    .select(`
      id, title, description, price, area, location_text, created_at,
      bhk_types (label), listing_types (name), property_types (name)
    `)
    .eq("id", params.id)
    .single<PropertyDataType>();

  if (propertyError || !propertyData) {
    console.error(`Error fetching property with ID ${params.id}:`, propertyError?.message);
    return (
      <>
        <Header />
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Property Not Found</h1>
          <p className="text-gray-700">We couldn't find the property with ID: {params.id}.</p>
          {propertyError && <p className="text-sm text-gray-500 mt-2">Error: {propertyError.message}</p>}
        </div>
      </>
    );
  }

  const { data: imagesData, error: imagesError } = await supabase
    .from("property_images")
    .select("id, image_url")
    .eq("property_id", params.id);

  if (imagesError) {
    console.warn(`Warning: Error fetching images for property ID ${params.id}:`, imagesError.message);
    // Continue without images if there's an error, or handle more strictly
  }

  const flattenedProperty: FlattenedProperty = {
    id: propertyData.id,
    title: propertyData.title ?? 'N/A',
    description: propertyData.description ?? 'No description available.',
    price: propertyData.price ?? 0,
    area: propertyData.area ?? 0, // Ensure 'area' matches your DB column (e.g., area_sqft)
    location_text: propertyData.location_text ?? 'N/A',
    created_at: propertyData.created_at ? new Date(propertyData.created_at).toISOString() : new Date(0).toISOString(),
    bhk_type: propertyData.bhk_types?.label ?? 'N/A',
    listing_type: propertyData.listing_types?.name ?? 'N/A',
    property_type: propertyData.property_types?.name ?? 'N/A',
  };

  // --- Server-side validation of image URLs ---
  // This ensures we only pass valid image URLs to the client.
  const images = await Promise.all(
    (imagesData || []).map(async (img) => {
      if (!img.image_url || img.image_url.trim() === '') {
        console.warn(`Server-side: Invalid or empty image_url for image id ${img.id}`);
        return null;
      }

      // Use a temporary cache-buster for the HEAD request only, to ensure we check the actual file
      const headCheckUrl = new URL(img.image_url);
      headCheckUrl.searchParams.set('check_ts', Date.now().toString());

      try {
        const response = await fetch(headCheckUrl.toString(), { method: 'HEAD', cache: 'no-store' });
        if (response.ok) {
          return {
            ...img,
            image_url: img.image_url // Pass the ORIGINAL URL to the client for better caching
          };
        } else {
          console.warn(`Server-side: Image not found or error (status ${response.status}) for URL: ${img.image_url}`);
          return null;
        }
      } catch (error) {
        console.error(`Server-side: Error during HEAD request for ${img.image_url}:`, error);
        return null;
      }
    })
  );

  const validatedImages = images.filter(Boolean) as ImageType[];
  console.log(`PropertyPage Server Component: Passing ${validatedImages.length} validated images to client.`);

  return (
    <>
      <Header />
      <PropertyDetailsClient
        property={flattenedProperty}
        images={validatedImages} // Pass only validated images with original URLs
      />
    </>
  );
}
