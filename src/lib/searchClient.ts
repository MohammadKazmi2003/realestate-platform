import type { SearchQueryInput } from './validation';
import { logger } from './logger';
import { supabase } from './supabaseClient';

const SEARCH_API = '/api/search';
const AUTOCOMPLETE_API = '/api/search/autocomplete';

async function pgFallbackSearch(params: SearchQueryInput): Promise<any> {
  logger.warn('ES search failed, falling back to PostgreSQL', params);
  try {
    const rpcParams: any = {
      p_location_text: params.location || null,
      p_min_price: params.minPrice ?? null,
      p_max_price: params.maxPrice ?? null,
    };
    if (params.bhkType) rpcParams.p_bhk_type_id = null;
    if (params.propertyType) rpcParams.p_property_type_id = null;
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
        area_sqft: p.area,
        area_unit: p.area_unit,
        property_type: p.property_type_name,
        bhk_type: p.bhk_type_label,
        all_images: p.image_url ? [p.image_url] : [],
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

export async function searchProperties(params: SearchQueryInput): Promise<any> {
  try {
    const response = await fetch(SEARCH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
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
    logger.error('Search API network error, falling back to PG', err.message);
    return pgFallbackSearch(params);
  }
}

export async function autocompleteSearch(query: string) {
  try {
    const response = await fetch(`${AUTOCOMPLETE_API}?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      return { suggestions: [] };
    }
    return response.json();
  } catch {
    return { suggestions: [] };
  }
}

export interface SearchResult {
  id: string;
  title: string | null;
  location_text: string | null;
  price: number | null;
  area: number | null;
  area_unit: string | null;
  owner_phone: string | null;
  user_id: string | null;
  images: { image_url: string }[];
  property_type_name: string | null;
  bhk_type_label: string | null;
  bathrooms: number | null;
  balconies: number | null;
  cabins: number | null;
  workstations: number | null;
  latitude: number | null;
  longitude: number | null;
}

export function mapEsResultToPropertyCard(esResult: any): SearchResult {
  const location = esResult.location || {};
  return {
    id: esResult.id,
    title: esResult.title || null,
    location_text: esResult.location_text || null,
    price: esResult.price || null,
    area: esResult.area_sqft || null,
    area_unit: esResult.area_unit || 'sqft',
    owner_phone: esResult.owner_phone || null,
    user_id: esResult.user_id || null,
    images: esResult.image_url
      ? [{ image_url: esResult.image_url }]
      : (esResult.all_images || []).length > 0
        ? esResult.all_images.map((url: string) => ({ image_url: url }))
        : [],
    property_type_name: esResult.property_type || null,
    bhk_type_label: esResult.bhk_type || null,
    bathrooms: esResult.bathrooms ?? null,
    balconies: esResult.balconies ?? null,
    cabins: null,
    workstations: null,
    latitude: location?.lat ?? null,
    longitude: location?.lon ?? null,
  };
}

export { SEARCH_API, AUTOCOMPLETE_API };
