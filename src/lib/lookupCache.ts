import { cacheGet, cacheSet } from './redis';
import { supabase } from './supabaseClient';

const CACHE_TTL = 3600;

type LookupTable = { id: number; name?: string; label?: string }[];

async function fetchAndCache(tableName: string): Promise<LookupTable> {
  const cached = await cacheGet<LookupTable>(`lookup:${tableName}`);
  if (cached) return cached;

  const { data, error } = await supabase.from(tableName).select('*');
  if (error) throw error;

  const result: LookupTable = data || [];
  await cacheSet(`lookup:${tableName}`, result, CACHE_TTL);
  return result;
}

export const lookupCache = {
  bhkTypes: () => fetchAndCache('bhk_types'),
  propertyTypes: () => fetchAndCache('property_types'),
  listingPurposes: () => fetchAndCache('lookup_listing_purposes'),
  amenities: () => fetchAndCache('lookup_amenities'),
  furnishings: () => fetchAndCache('lookup_furnishing_items'),
  otherRooms: () => fetchAndCache('lookup_other_rooms'),
  locationAdvantages: () => fetchAndCache('lookup_location_advantages'),
  landFeatures: () => fetchAndCache('lookup_land_features'),
  furnishingStatuses: () => fetchAndCache('lookup_furnishing_statuses'),
  ownershipTypes: () => fetchAndCache('lookup_ownership_types'),
  availabilityStatuses: () => fetchAndCache('lookup_availability_statuses'),
  commercialSubTypes: () => fetchAndCache('lookup_commercial_sub_types'),
  commercialOfficeTypes: () => fetchAndCache('lookup_commercial_office_types'),
};

export function invalidateLookupCache() {
  const tables = [
    'bhk_types', 'property_types', 'lookup_listing_purposes', 'lookup_amenities',
    'lookup_furnishing_items', 'lookup_other_rooms', 'lookup_location_advantages',
    'lookup_land_features', 'lookup_furnishing_statuses', 'lookup_ownership_types',
    'lookup_availability_statuses', 'lookup_commercial_sub_types', 'lookup_commercial_office_types',
  ];
  tables.forEach((t) => {
    import('./redis').then(({ cacheDelete }) => cacheDelete(`lookup:${t}`));
  });
}
