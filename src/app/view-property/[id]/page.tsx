// app/view-property/[id]/page.tsx
import { cookies } from "next/headers";
import { createServerComponentClient } from "@supabase/ssr";
import PropertyDetailsClient from "../../property/[id]/PropertyDetailsClient";

interface Props {
  params: { id: string };
}

export default async function Page({ params }: Props) {
  const supabase = createServerComponentClient({ cookies });

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
    return <div>Property not found.</div>;
  }

  const { data: images, error: imagesError } = await supabase
    .from("property_images")
    .select("id, image_url")
    .eq("property_id", params.id);

  return (
    <PropertyDetailsClient
      property={{
        ...property,
        bhk_type: property.bhk_types?.label,
        listing_type: property.listing_types?.name,
        property_type: property.property_types?.name,
      }}
      images={images || []}
    />
  );
}
