import type { SearchQueryInput } from './validation';
import { logger } from './logger';
import { supabase } from './supabaseClient';

const SEARCH_API = '/api/search';
const AUTOCOMPLETE_API = '/api/search/autocomplete';

// Cached id lookup so the PG fallback can filter by intent without the
// client needing to know per-environment lookup IDs (Sell vs Sale drift).
let listingPurposeIdCache: Record<string, number> | null = null;
async function resolveListingPurposeId(label?: string | null): Promise<number | null> {
  if (!label || !label.trim()) return null;
  const t = label.trim().toLowerCase();
  try {
    if (!listingPurposeIdCache) {
      const { data } = await supabase.from('lookup_listing_purposes').select('id,name');
      const map: Record<string, number> = {};
      for (const row of (data as any[]) || []) {
        map[String(row.name).trim().toLowerCase()] = row.id;
      }
      listingPurposeIdCache = map;
    }
    if (t === 'sell' || t === 'sale') {
      return listingPurposeIdCache['sell'] ?? listingPurposeIdCache['sale'] ?? null;
    }
    return listingPurposeIdCache[t] ?? null;
  } catch {
    return null;
  }
}

async function pgFallbackSearch(params: SearchQueryInput): Promise<any> {
  logger.warn('ES search failed, falling back to PostgreSQL', params);
  try {
    const rpcParams: any = {
      p_location_text: params.location || null,
      p_min_price: params.minPrice ?? null,
      p_max_price: params.maxPrice ?? null,
    };
    if (params.bhkType) rpcParams.p_bhk_type = params.bhkType;
    if (params.propertyType) rpcParams.p_property_type = params.propertyType;
    if (params.listingPurpose) {
      const pid = await resolveListingPurposeId(params.listingPurpose);
      if (pid != null) rpcParams.p_listing_purpose_id = pid;
    }
    if (params.lat != null && params.lng != null && params.radiusKm) {
      rpcParams.min_lat = params.lat - (params.radiusKm / 111);
      rpcParams.max_lat = params.lat + (params.radiusKm / 111);
      rpcParams.min_lng = params.lng - (params.radiusKm / (111 * Math.cos(params.lat * Math.PI / 180)));
      rpcParams.max_lng = params.lng + (params.radiusKm / (111 * Math.cos(params.lat * Math.PI / 180)));
    }
    if (params.bounds) {
      rpcParams.min_lat = params.bounds.minLat;
      rpcParams.max_lat = params.bounds.maxLat;
      rpcParams.min_lng = params.bounds.minLng;
      rpcParams.max_lng = params.bounds.maxLng;
    }
    const { data, error } = await supabase.rpc('search_properties', rpcParams);
    if (error) throw error;
    return {
      results: (data || []).map((p: any) => ({
        ...p,
        location: p.latitude != null && p.longitude != null ? { lat: p.latitude, lon: p.longitude } : null,
        area_sqft: p.area_sqft ?? p.area ?? null,
        area_unit: p.area_unit || 'sqft',
        property_type: p.property_type_name ?? p.property_type ?? null,
        bhk_type: p.bhk_type_label ?? p.bhk_type ?? null,
        furnishing_status: p.furnishing_status ?? null,
        listing_purpose: p.listing_purpose ?? null,
        bedrooms: p.bedrooms ?? null,
        cabins: p.cabins ?? null,
        workstations: p.workstations ?? p.max_seats ?? null,
        all_images: p.image_url ? [p.image_url] : (Array.isArray(p.all_images) ? p.all_images : []),
      })),
      total: data?.length || 0,
      nextCursor: null,
      aggregations: { facets: {} },
    };
  } catch (fallbackError) {
    logger.error('PG fallback search also failed', fallbackError);
    return { results: [], total: 0, nextCursor: null, aggregations: { facets: {} } };
  }
}

export async function searchProperties(params: SearchQueryInput, signal?: AbortSignal): Promise<any> {
  try {
    const response = await fetch(SEARCH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });

    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        logger.warn('API unavailable, falling back to PG', { status: response.status });
        return pgFallbackSearch(params);
      }
      logger.error('Search API returned error', { status: response.status });
      return pgFallbackSearch(params);
    }

    return response.json();
  } catch (err: any) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    logger.error('Search API network error, falling back to PG', err.message);
    return pgFallbackSearch(params);
  }
}

export async function autocompleteSearch(query: string, signal?: AbortSignal, scope?: string) {
  try {
    const scopeParam = scope ? `&scope=${scope}` : '';
    const response = await fetch(`${AUTOCOMPLETE_API}?q=${encodeURIComponent(query)}${scopeParam}`, {
      signal: signal || AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { suggestions: [] };
    }
    const data = await response.json();
    return data;
  } catch (err: any) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return { suggestions: [] };
  }
}

export interface SearchResult {
  id: string;
  title: string | null;
  location_text: string | null;
  price: number | null;
  area: number | null;
  area_sqft?: number | null;
  area_unit: string | null;
  owner_phone: string | null;
  user_id: string | null;
  images: { image_url: string }[];
  image_url?: string | null;
  property_type_name: string | null;
  property_type?: string | null;
  bhk_type_label: string | null;
  bhk_type?: string | null;
  bedrooms?: number | null;
  bathrooms: number | null;
  balconies: number | null;
  cabins: number | null;
  workstations: number | null;
  min_seats?: number | null;
  max_seats?: number | null;
  furnishing_status?: string | null;
  listing_purpose?: string | null;
  latitude: number | null;
  longitude: number | null;
}

export function mapEsResultToPropertyCard(esResult: any): SearchResult {
  const location = esResult.location || {};
  const allImages: string[] = Array.isArray(esResult.all_images) ? esResult.all_images : [];
  return {
    id: esResult.id,
    title: esResult.title || null,
    location_text: esResult.location_text || null,
    price: esResult.price ?? esResult.sort_price ?? null,
    area: esResult.area_sqft ?? null,
    area_sqft: esResult.area_sqft ?? null,
    area_unit: esResult.area_unit || 'sqft',
    owner_phone: esResult.owner_phone || null,
    user_id: esResult.user_id || null,
    images: esResult.image_url
      ? [{ image_url: esResult.image_url }]
      : allImages.length > 0
        ? allImages.map((url: string) => ({ image_url: url }))
        : [],
    image_url: esResult.image_url || allImages[0] || null,
    property_type_name: esResult.property_type || null,
    property_type: esResult.property_type || null,
    bhk_type_label: esResult.bhk_type || null,
    bhk_type: esResult.bhk_type || null,
    bedrooms: esResult.bedrooms ?? null,
    bathrooms: esResult.bathrooms ?? null,
    balconies: esResult.balconies ?? null,
    cabins: esResult.cabins ?? null,
    workstations: esResult.workstations ?? esResult.max_seats ?? null,
    min_seats: esResult.min_seats ?? null,
    max_seats: esResult.max_seats ?? null,
    furnishing_status: esResult.furnishing_status || null,
    listing_purpose: esResult.listing_purpose || null,
    latitude: location?.lat ?? null,
    longitude: location?.lon ?? null,
  };
}

export { SEARCH_API, AUTOCOMPLETE_API };
