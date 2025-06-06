// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic';

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";
import { unstable_noStore as noStore } from 'next/cache';

// Type for the data structure returned by the Supabase query
export type PropertyDataType = {
  id: string;
  user_id: string | null;
  title: string | null;
  description: string | null;
  price: number | null;
  area_sqft: number | null;
  location_text: string | null;
  created_at: string | null;
  bhk_types: { label: string | null } | null;
  listing_types: { name: string | null } | null;
  property_types: { name: string | null } | null;
};

// This type is for the data structure passed to the client component
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

// Type for image data
export type ImageType = {
  id: number;
  image_url: string | null;
};

// The component function is now async to correctly handle server-side data fetching
export default async function PropertyPage({ params }: { params: { id: string } }) {
  noStore();
  const supabase = createSupabaseServerClient();
  const { id } = params; // Destructuring here is safe inside an async component

  console.log(`PropertyPage Server Component: Fetching property ID ${id}`);

  const { data: propertyData, error: propertyError } = await supabase
    .from("properties")
    .select(`
      id, user_id, title, description, price, area_sqft, location_text, created_at,
      bhk_types (label), listing_types (name), property_types (name)
    `)
    .eq("id", id)
    .single<PropertyDataType>();

  if (propertyError || !propertyData) {
    console.error(`Error fetching property with ID ${id}:`, propertyError?.message);
    return (
      <>
        <Header />
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Property Not Found</h1>
          <p className="text-gray-700">We couldn't find the property with ID: {id}.</p>
          {propertyError && <p className="text-sm text-gray-500 mt-2">Error: {propertyError.message}</p>}
        </div>
      </>
    );
  }

  let ownerPhone: string | null = null;
  if (propertyData.user_id) {
    const { data: profileData } = await supabase
      .from('profiles')
      .select('phone_number')
      .eq('id', propertyData.user_id)
      .single();
    ownerPhone = profileData?.phone_number || null;
  }

  const { data: imagesData } = await supabase
    .from("property_images")
    .select("id, image_url")
    .eq("property_id", id);

  const images = await Promise.all(
    (imagesData || []).map(async (img) => {
      if (!img.image_url) return null;
      try {
        const response = await fetch(img.image_url, { method: 'HEAD', cache: 'no-store' });
        return response.ok ? { ...img, image_url: img.image_url } : null;
      } catch {
        return null;
      }
    })
  );
  const validatedImages = images.filter(Boolean) as ImageType[];

  const flattenedProperty: FlattenedProperty = {
    id: propertyData.id,
    title: propertyData.title ?? 'N/A',
    description: propertyData.description ?? 'No description available.',
    price: propertyData.price ?? 0,
    area: propertyData.area_sqft ?? 0,
    location_text: propertyData.location_text ?? 'N/A',
    created_at: propertyData.created_at ? new Date(propertyData.created_at).toISOString() : new Date(0).toISOString(),
    bhk_type: propertyData.bhk_types?.label ?? 'N/A',
    listing_type: propertyData.listing_types?.name ?? 'N/A',
    property_type: propertyData.property_types?.name ?? 'N/A',
  };

  return (
    <>
      <Header />
      <PropertyDetailsClient
        property={flattenedProperty}
        images={validatedImages}
        ownerPhone={ownerPhone}
      />
    </>
  );
}
