// src/app/property/[id]/page.tsx
import { cookies } from "next/headers";
import { createServerComponentClient } from "@supabase/ssr";
import PropertyDetailsClient from "./PropertyDetailsClient"; // Updated import path

interface Props {
  params: { id: string };
}

export default async function Page({ params }: Props) {
  const supabase = createServerComponentClient({ cookies });

  // Fetch property details with related data
  const { data: property, error: propertyError } = await supabase
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
    .single();

  if (propertyError || !property) {
    // You can customize this error/not found state
    console.error("Error fetching property:", propertyError);
    return (
      <div className="text-center p-8 text-lg text-red-500">
        Property not found or an error occurred.
      </div>
    );
  }

  // Fetch property images
  const { data: images, error: imagesError } = await supabase
    .from("property_images")
    .select("id, image_url")
    .eq("property_id", params.id);

  if (imagesError) {
    console.error("Error fetching images:", imagesError);
  }

  return (
    <PropertyDetailsClient
      property={{
        ...property,
        // Flatten the nested objects for the client component
        bhk_type: property.bhk_types?.label,
        listing_type: property.listing_types?.name,
        property_type: property.property_types?.name,
      }}
      images={images || []} // Ensure images is an array
    />
  );
}