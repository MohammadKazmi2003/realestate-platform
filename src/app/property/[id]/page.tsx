// src/app/property/[id]/page.tsx
export const dynamic = 'force-dynamic';

import { createSupabaseServerClient } from "@/lib/supabase/serverClient";
import PropertyDetailsClient from "./PropertyDetailsClient";
import Header from "@/app/components/Header";
import { unstable_noStore as noStore } from 'next/cache';
import type { PropertyDataType } from '@/lib/types';
import { logPropertyView } from '@/lib/actions';
import { cacheGet, cacheSet } from '@/lib/redis';

// ✅ Define params as a Promise
export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  noStore();
  
  // ✅ Await the params first
  const { id } = await params;

  let property: PropertyDataType | null = null;

  // Try cache first
  const cacheKey = `property:${id}`;
  const cached = await cacheGet<PropertyDataType>(cacheKey);
  if (cached) {
    property = cached;
  } else {
    // ✅ Await the Supabase client because we made it async in serverClient.ts
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase
      .rpc('get_property_details', { p_property_id: id })
      .returns<PropertyDataType>()
      .single();

    if (error || !data) {
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

    property = data;
    await cacheSet(cacheKey, property, 300);
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user && user.id !== property!.user_id) {
    await logPropertyView(property!.id, property!.user_id);
  }

  return (
    <div className="bg-bg-color min-h-screen">
      <Header />
      <PropertyDetailsClient property={property!} />
    </div>
  );
}