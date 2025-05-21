// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic'; // Ensures dynamic rendering

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";

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

  const flattenedProperty: FlattenedProperty = {
    id: propertyData.id,
    title: propertyData.title ?? 'N/A',
    description: propertyData.description ?? 'No description available.',
    price: propertyData.price ?? 0,
    area: propertyData.area ?? 0,
    location_text: propertyData.location_text ?? 'N/A',
    // Ensure created_at is a consistent ISO string for the client
    created_at: propertyData.created_at ? new Date(propertyData.created_at).toISOString() : new Date(0).toISOString(), // Fallback to epoch if null
    bhk_type: propertyData.bhk_types?.label ?? 'N/A',
    listing_type: propertyData.listing_types?.name ?? 'N/A',
    property_type: propertyData.property_types?.name ?? 'N/A',
  };

  const { data: images, error: imagesError } = await supabase
    .from("property_images")
    .select("id, image_url")
    .eq("property_id", params.id)
    .returns<ImageType[]>();

  if (imagesError) {
    console.error(`Error fetching images for property ID ${params.id}:`, imagesError.message);
  }

  return (
    <>
      <Header />
      <PropertyDetailsClient
        property={flattenedProperty}
        images={images || []}
      />
    </>
  );
}