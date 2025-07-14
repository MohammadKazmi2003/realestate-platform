// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic';

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";
import { unstable_noStore as noStore } from 'next/cache';
import type { PropertyDataType } from '@/lib/types';
import { logPropertyView } from '@/lib/actions'; // Import the new action

export default async function PropertyPage({ params }: { params: { id: string } }) {
  noStore();
  const supabase = createSupabaseServerClient();
  const { id } = params;

  const { data: property, error } = await supabase
    .rpc('get_property_details', { p_property_id: id })
    .returns<PropertyDataType>()
    .single();

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

  // --- FIX: Moved the logging logic to the success path ---
  const { data: { user } } = await supabase.auth.getUser();

  // We only log the view if a user is logged in AND they are not the owner of the property.
  // This prevents owners from inflating their own view counts.
  if (user && user.id !== property.user_id) {
    await logPropertyView(property.id);
  }
  // --- End of fix ---

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <PropertyDetailsClient property={property} />
    </div>
  );
}
