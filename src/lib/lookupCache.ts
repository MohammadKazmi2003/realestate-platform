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

export async function getCachedRpc<T = any>(cacheKey: string, rpcName: string, params: Record<string, any> = {}): Promise<T> {
  if (lookupCache.has(cacheKey)) return lookupCache.get(cacheKey)! as T;
  const { data, error } = await supabase.rpc(rpcName, params);
  if (!error && data != null) {
    lookupCache.set(cacheKey, data);
    return data as T;
  }
  return [] as unknown as T;
}

export function setLookupCache(key: string, value: any[]) {
  lookupCache.set(key, value);
}

export function invalidateLookupCache() {
  lookupCache.clear();
}
