// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic'; // Ensures dynamic rendering

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";
import { unstable_noStore as noStore } from 'next/cache'; // Import noStore

interface Props {
  params: { id: string };
}

export type PropertyDataType = {
  id: string;
  title: string | null;
  description: string | null;
  price: number | null;
  area: number | null;
  location_text: string | null;
  created_at: string | null; // Expecting ISO string or similar from DB
  bhk_types: { label: string | null } | null;
  listing_types: { name: string | null } | null;
  property_types: { name: string | null } | null;
  // FIX: Removed property_images from this type as it's fetched separately
};

export type FlattenedProperty = {
  id: string;
  title: string;
  description: string;
  price: number;
  area: number;
  location_text: string;
  created_at: string; // This will be an ISO string
  bhk_type: string;
  listing_type: string;
  property_type: string;
};

export type ImageType = {
  id: number;
  image_url: string | null;
};

export default async function PropertyPage({ params }: Props) {
  noStore(); // Opt out of data caching for this route

  const supabase = createSupabaseServerClient();

  const { data: propertyData, error: propertyError } = await supabase
    .from("properties")
    .select(`
      id,
      title,
      description,
      price,
      area,
      location_text,
      created_at,
      bhk_types (
        label
      ),
      listing_types (
        name
      ),
      property_types (
        name
      )
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

  // Fetch images separately to ensure we can modify their URLs and validate
  const { data: imagesData, error: imagesError } = await supabase
    .from("property_images")
    .select("id, image_url")
    .eq("property_id", params.id);

  if (imagesError) {
    console.error(`Error fetching images for property ID ${params.id}:`, imagesError.message);
  }

  const flattenedProperty: FlattenedProperty = {
    id: propertyData.id,
    title: propertyData.title ?? 'N/A',
    description: propertyData.description ?? 'No description available.',
    price: propertyData.price ?? 0,
    area: propertyData.area ?? 0,
    location_text: propertyData.location_text ?? 'N/A',
    created_at: propertyData.created_at ? new Date(propertyData.created_at).toISOString() : new Date(0).toISOString(),
    bhk_type: propertyData.bhk_types?.label ?? 'N/A',
    listing_type: propertyData.listing_types?.name ?? 'N/A',
    property_type: propertyData.property_types?.name ?? 'N/A',
  };

  // --- IMPORTANT FIX: Server-side validation and cache-busting for image URLs ---
  const images = await Promise.all(
    (imagesData || []).map(async (img) => { // Use imagesData here
      if (!img.image_url || img.image_url.trim() === '') {
        return null; // Filter out invalid URLs
      }

      const url = new URL(img.image_url);
      // Append a timestamp to force a fresh fetch by the browser
      url.searchParams.set('cb', Date.now().toString());

      try {
        // Perform a HEAD request to check if the image exists
        const response = await fetch(url.toString(), { method: 'HEAD', cache: 'no-store' }); // Disable fetch cache for this check

        if (response.ok) { // Status 2xx means OK
          return {
            ...img,
            image_url: url.toString() // Use the URL with cache-buster
          };
        } else if (response.status === 404) {
          console.warn(`Server-side: Image not found (404) for URL: ${url.toString()}`);
          return null; // Image does not exist, filter it out
        } else {
          console.warn(`Server-side: Unexpected status ${response.status} for image URL: ${url.toString()}`);
          return null; // Treat other errors as non-existent for rendering purposes
        }
      } catch (error) {
        console.error(`Server-side: Error fetching image HEAD for ${url.toString()}:`, error);
        return null; // Filter out images that cause network errors
      }
    })
  );

  // Filter out any nulls from the validation process
  const validatedImages = images.filter(Boolean) as ImageType[];
  // --- END IMPORTANT FIX ---

  return (
    <>
      <Header />
      <PropertyDetailsClient
        property={flattenedProperty}
        images={validatedImages} // Pass only validated images
      />
    </>
  );
}
