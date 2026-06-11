import { supabase } from './supabaseClient';

const lookupCache = new Map<string, any[]>();

export async function getLookup(table: string): Promise<any[]> {
  if (lookupCache.has(table)) return lookupCache.get(table)!;
  const { data, error } = await supabase.from(table).select('*');
  if (!error && data) {
    lookupCache.set(table, data);
    return data;
  }
  return [];
}

export function invalidateLookupCache() {
  lookupCache.clear();
}
