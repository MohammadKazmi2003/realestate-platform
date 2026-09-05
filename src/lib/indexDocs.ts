import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  getElasticsearchClient,
  ES_INDEX_ALIAS,
  PROJECTS_INDEX_ALIAS,
} from './elasticsearch';
import { cacheDelete } from './redis';

// Shared single-document builders + writers for incremental indexing.
//
// Source of truth for the ES document shape used by the `search-index`
// worker and the inline fallback. The bulk full-sync scripts
// (scripts/es-indexer.js, scripts/es-project-indexer.js) keep their own
// copies and remain the admin/recovery path — if the shape changes here,
// mirror it there (and vice versa) so incremental and full sync agree.

export type IndexEntity = 'property' | 'project';

let supabaseAdmin: SupabaseClient | null = null;

function getAdminClient(): SupabaseClient {
  if (supabaseAdmin) return supabaseAdmin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('indexDocs: missing Supabase URL/service key env');
  }
  supabaseAdmin = createClient(url, key);
  return supabaseAdmin;
}

function parseWKTPoint(wkt: unknown): { latitude: number | null; longitude: number | null } {
  if (typeof wkt !== 'string' || !wkt) return { latitude: null, longitude: null };
  const wktMatch = wkt.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  if (wktMatch) {
    return { latitude: parseFloat(wktMatch[2]), longitude: parseFloat(wktMatch[1]) };
  }
  try {
    const hex = wkt.replace(/\s/g, '');
    const buf = Buffer.from(hex, 'hex');
    if (buf.length >= 25) {
      const le = buf.readUInt8(0) === 1;
      const srid = le ? buf.readUInt32LE(5) : buf.readUInt32BE(5);
      if (srid === 4326) {
        const lng = le ? buf.readDoubleLE(9) : buf.readDoubleBE(9);
        const lat = le ? buf.readDoubleLE(17) : buf.readDoubleBE(17);
        return { latitude: lat, longitude: lng };
      }
    }
  } catch {
    // fall through to nulls
  }
  return { latitude: null, longitude: null };
}

function bedroomsFromBhk(bhkLabel: string | null): number | null {
  if (!bhkLabel) return null;
  if (/^studio/i.test(bhkLabel.trim())) return 0;
  const m = bhkLabel.match(/(\d+(\.\d+)?)/);
  return m ? Math.floor(parseFloat(m[1])) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

/** Full property document. Returns null when the row is gone (caller deletes the ES doc). */
export async function buildPropertyDoc(propertyId: string): Promise<AnyRow | null> {
  const supabase = getAdminClient();
  const { data: property } = await supabase.from('properties').select('*').eq('id', propertyId).maybeSingle();
  if (!property) return null;

  const [
    amenitiesRes, furnishingsRes, otherRoomsRes, advantagesRes, mediaRes,
    projectRes, profileRes, typeRes, purposeRes, residentialRes, commercialRes, landRes,
  ] = await Promise.all([
    supabase.from('junction_property_amenities').select('amenity_id, lookup_amenities(name)').eq('property_id', propertyId),
    supabase.from('junction_property_furnishings').select('furnishing_item_id, lookup_furnishing_items(name)').eq('property_id', propertyId),
    supabase.from('junction_property_other_rooms').select('room_id, lookup_other_rooms(name)').eq('property_id', propertyId),
    supabase.from('junction_property_location_advantages').select('advantage_id, lookup_location_advantages(name)').eq('property_id', propertyId),
    supabase.from('property_media').select('media_url, media_type, display_order').eq('property_id', propertyId).order('display_order'),
    supabase.from('projects').select('name, builder_name, developer_id, developers(name)').eq('id', property.project_id).maybeSingle(),
    supabase.from('profiles').select('name, phone_number').eq('id', property.user_id).single(),
    supabase.from('property_types').select('name').eq('id', property.property_type_id).single(),
    supabase.from('lookup_listing_purposes').select('name').eq('id', property.listing_purpose_id).single(),
    supabase.from('details_residential').select('*, bhk_types(label), lookup_furnishing_statuses(name)').eq('property_id', propertyId).maybeSingle(),
    supabase.from('details_commercial').select('*, lookup_commercial_sub_types(name), lookup_furnishing_statuses(name)').eq('property_id', propertyId).maybeSingle(),
    supabase.from('details_land').select('*').eq('property_id', propertyId).maybeSingle(),
  ]);

  const resData = (residentialRes as AnyRow)?.data || null;
  const comData = (commercialRes as AnyRow)?.data || null;
  const areaData = (landRes as AnyRow)?.data || resData || comData || {};
  const bhkLabel: string | null = resData?.bhk_types?.label || null;
  const furnishingStatus =
    resData?.lookup_furnishing_statuses?.name || comData?.lookup_furnishing_statuses?.name || comData?.furnishing_status || null;
  const coords = parseWKTPoint(property.location_point);

  return {
    id: property.id,
    title: property.title || '',
    description: property.description || '',
    location_text: property.location_text || '',
    location:
      coords.latitude != null && coords.longitude != null
        ? { lat: coords.latitude, lon: coords.longitude }
        : null,
    price: property.price || 0,
    sort_price: property.price || 0,
    entity_type: 'property',
    property_type: (typeRes as AnyRow)?.data?.name || '',
    property_type_id: property.property_type_id,
    listing_purpose: (purposeRes as AnyRow)?.data?.name || '',
    listing_purpose_id: property.listing_purpose_id,
    availability_status: '',
    ownership_type: '',
    bhk_type: bhkLabel || '',
    bhk_type_id: resData?.bhk_type_id || null,
    bedrooms: bedroomsFromBhk(bhkLabel),
    bathrooms: resData?.bathrooms ?? 0,
    balconies: resData?.balconies ?? 0,
    cabins: (commercialRes as AnyRow)?.data?.cabins ?? 0,
    workstations: (commercialRes as AnyRow)?.data?.workstations ?? (commercialRes as AnyRow)?.data?.max_seats ?? 0,
    min_seats: (commercialRes as AnyRow)?.data?.min_seats ?? 0,
    max_seats: (commercialRes as AnyRow)?.data?.max_seats ?? 0,
    area_sqft:
      areaData.carpet_area ?? areaData.built_up_area ?? areaData.super_built_up_area ?? areaData.plot_area ?? 0,
    area_unit: (landRes as AnyRow)?.data?.area_unit || 'sqft',
    furnishing_status: furnishingStatus || '',
    amenities: ((amenitiesRes as AnyRow)?.data || []).map((a: AnyRow) => a.lookup_amenities?.name || '').filter(Boolean),
    furnishings: ((furnishingsRes as AnyRow)?.data || []).map((f: AnyRow) => f.lookup_furnishing_items?.name || '').filter(Boolean),
    other_rooms: ((otherRoomsRes as AnyRow)?.data || []).map((r: AnyRow) => r.lookup_other_rooms?.name || '').filter(Boolean),
    location_advantages: ((advantagesRes as AnyRow)?.data || []).map((a: AnyRow) => a.lookup_location_advantages?.name || '').filter(Boolean),
    is_price_negotiable: property.is_price_negotiable || false,
    status: property.status || 'available',
    property_score: property.property_score || 0,
    image_url: (mediaRes as AnyRow)?.data?.[0]?.media_url || null,
    all_images: ((mediaRes as AnyRow)?.data || []).map((m: AnyRow) => m.media_url),
    owner_name: (profileRes as AnyRow)?.data?.name || '',
    owner_phone: (profileRes as AnyRow)?.data?.phone_number || '',
    project_name: (projectRes as AnyRow)?.data?.name || '',
    developer_name:
      (projectRes as AnyRow)?.data?.builder_name || (projectRes as AnyRow)?.data?.developers?.name || '',
    created_at: property.created_at,
    updated_at: property.updated_at,
    suggest: [property.title?.trim(), property.location_text?.trim(), (projectRes as AnyRow)?.data?.name?.trim()].filter(Boolean),
  };
}

/** Full project document. Returns null when the row is gone (caller deletes the ES doc). */
export async function buildProjectDoc(projectId: string): Promise<AnyRow | null> {
  const supabase = getAdminClient();
  const { data: project } = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle();
  if (!project) return null;

  const [developerRes, imageRes, locationRes, amenityRes, unitsRes] = await Promise.all([
    supabase.from('developers').select('name').eq('id', project.developer_id).maybeSingle(),
    supabase
      .from('project_images')
      .select('storage_path_original')
      .eq('project_id', projectId)
      .order('is_primary', { ascending: false })
      .order('id', { ascending: true })
      .limit(10),
    supabase
      .from('project_locations')
      .select('locations(name)')
      .eq('project_id', projectId)
      .order('level', { referencedTable: 'locations', ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('project_amenities').select('amenities(name)').eq('project_id', projectId),
    supabase.from('unit_configurations').select('bedrooms').eq('project_id', projectId),
  ]);

  const amenities = ((amenityRes as AnyRow)?.data || []).map((a: AnyRow) => a.amenities?.name || '').filter(Boolean);
  const gallery = ((imageRes as AnyRow)?.data || [])
    .map((r: AnyRow) => r.storage_path_original)
    .filter((u: unknown) => typeof u === 'string' && (u as string).length > 0);
  const bedrooms_list = Array.from(
    new Set((((unitsRes as AnyRow)?.data || []).map((u: AnyRow) => u.bedrooms) as unknown[]).filter(
      (b): b is number => Number.isInteger(b) && (b as number) >= 0
    ))
  ).sort((a, b) => a - b);

  return {
    id: project.id,
    name: project.name || '',
    slug: project.slug || '',
    description: project.description_html || project.description || '',
    developer_name: (developerRes as AnyRow)?.data?.name || project.builder_name || '',
    low_price: project.low_price || 0,
    high_price: project.high_price || 0,
    sort_price: project.low_price || 0,
    entity_type: 'project',
    status: 'available',
    construction_phase: project.construction_phase || '',
    delivery_date: project.delivery_date || null,
    location_text: (locationRes as AnyRow)?.data?.locations?.name || '',
    location:
      project.latitude != null && project.longitude != null
        ? { lat: Number(project.latitude), lon: Number(project.longitude) }
        : null,
    amenities,
    image_url: gallery[0] || null,
    all_images: gallery,
    bedrooms_list,
    unit_count: ((unitsRes as AnyRow)?.data || []).length,
    payment_plan_summary: project.payment_plan_summary || null,
    construction_progress_percent: project.construction_progress_percent ?? null,
    created_at: project.created_at,
    suggest: [
      project.name?.trim(),
      (locationRes as AnyRow)?.data?.locations?.name?.trim(),
      (developerRes as AnyRow)?.data?.name?.trim(),
    ].filter(Boolean),
  };
}

function aliasFor(entity: IndexEntity): string {
  return entity === 'project' ? PROJECTS_INDEX_ALIAS : ES_INDEX_ALIAS;
}

/**
 * Index (or re-index) exactly one listing. The document is rebuilt from the
 * current DB row, so collapsed/duplicate jobs always converge to latest state.
 * A missing row (or soft-deleted status) becomes an ES delete — hard deletes
 * and tombstones can never leave ghost documents behind.
 */
export async function indexOne(entity: IndexEntity, id: string): Promise<'indexed' | 'deleted'> {
  const es = getElasticsearchClient();
  const doc = entity === 'project' ? await buildProjectDoc(id) : await buildPropertyDoc(id);
  if (!doc || doc.status === 'deleted') {
    await deleteOne(entity, id);
    return 'deleted';
  }
  await es.index({ index: aliasFor(entity), id, document: doc, refresh: true });
  await invalidateListingCaches(id);
  return 'indexed';
}

/** Delete exactly one ES document (404-safe) + drop cached card payloads. */
export async function deleteOne(entity: IndexEntity, id: string): Promise<void> {
  const es = getElasticsearchClient();
  try {
    await es.delete({ index: aliasFor(entity), id, refresh: true });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status !== 404) throw err;
  }
  await invalidateListingCaches(id);
}

async function invalidateListingCaches(id: string): Promise<void> {
  await Promise.all([cacheDelete(`l:v3:${id}`), cacheDelete(`property:${id}`)]);
}
