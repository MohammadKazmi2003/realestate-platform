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

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <PropertyDetailsClient property={property} />
    </div>
  );
}