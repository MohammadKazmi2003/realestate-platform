// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic';

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";
import { unstable_noStore as noStore } from 'next/cache';
import type { PropertyDataType } from '@/lib/types';

export default async function PropertyPage({ params }: { params: { id: string } }) {
  noStore();
  const supabase = createSupabaseServerClient();
  const { id } = params;

  // This is the final, comprehensive query. It fetches all related data
  // for a property in a single network request, using the correct table names and relationships.
  const { data: property, error } = await supabase
    .from("properties")
    .select(`
      id,
      user_id,
      title,
      description,
      price,
      is_price_negotiable,
      location_text,
      created_at,
      profiles!inner ( name, phone_number ),
      property_types ( name ),
      lookup_listing_purposes ( name ),
      lookup_availability_statuses ( name ),
      lookup_ownership_types ( name ),
      details_residential (
        bathrooms, balconies, carpet_area, super_built_up_area, total_floors, property_on_floor,
        bhk_types ( label ),
        lookup_furnishing_statuses ( name )
      ),
      details_commercial (
        cabins, workstations, meeting_rooms, private_washrooms, is_pre_leased, has_noc, has_occupancy_cert,
        lookup_commercial_sub_types ( name )
      ),
      property_media ( id, media_url, media_type, tag ),
      lookup_amenities ( name ),
      lookup_furnishing_items ( name ),
      lookup_other_rooms ( name ),
      lookup_location_advantages ( name )
    `)
    .eq("id", id)
    .single<PropertyDataType>();

  if (error || !property) {
    console.error(`Error fetching property ${id}:`, error?.message);
    return (
      <div className="bg-bg-color min-h-screen">
        <Header />
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold text-danger-color mb-4">Property Not Found</h1>
          <p className="text-gray-700">We couldn't find the details for this property. It may have been removed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <PropertyDetailsClient property={property} />
    </div>
  );
}
