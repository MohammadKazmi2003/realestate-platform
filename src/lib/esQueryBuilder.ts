import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';

function sanitize(s: string | undefined, maxLen = 200): string | undefined {
  if (!s) return s;
  if (s.length > maxLen) return s.slice(0, maxLen);
  if (/(.)\1{10,}/.test(s)) return s.slice(0, 50);
  return s;
}

function buildSortClause(sort: string, lat?: number, lng?: number, scope?: string) {
  // Unique tiebreaker so search_after pagination can never return the same
  // doc on two pages (tied created_at/price/_score otherwise overlap, which
  // surfaces as duplicate React keys in infinite-scroll lists). Uses the
  // keyword `id` field — _id sorting is disallowed (no fielddata) in ES 8.
  return [...buildSortClauseInner(sort, lat, lng, scope), { id: { order: 'asc' } }];
}

function buildSortClauseInner(sort: string, lat?: number, lng?: number, scope?: string) {
  // NOTE: zero-price docs sort last via missing:'_last' (indexed, no painless
  // script) — cheaper than the previous _script sort and filter-cache friendly.
  if (scope === 'both') {
    if (sort === 'price_asc') {
      return [
        { sort_price: { order: 'asc', missing: '_last' } },
        { _score: { order: 'desc' } },
      ];
    }
    if (sort === 'price_desc') {
      return [
        { sort_price: { order: 'desc', missing: '_last' } },
        { _score: { order: 'desc' } },
      ];
    }
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
    if (sort === 'popular') return [{ _score: { order: 'desc' } }];
    // Unknown sort values fall back to newest (honest default).
    return [{ created_at: { order: 'desc' } }];
  }
  if (scope === 'projects') {
    if (sort === 'price_asc') return [{ low_price: { order: 'asc', missing: '_last' } }, { _score: { order: 'desc' } }];
    if (sort === 'price_desc') return [{ low_price: { order: 'desc', missing: '_last' } }, { _score: { order: 'desc' } }];
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
    if (sort === 'popular') return [{ _score: { order: 'desc' } }];
    return [{ created_at: { order: 'desc' } }];
  }
  if (sort === 'price_asc') return [{ price: { order: 'asc', missing: '_last' } }, { _score: { order: 'desc' } }];
  if (sort === 'price_desc') return [{ price: { order: 'desc' } }, { _score: { order: 'desc' } }];
  if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
  if (sort === 'popular') return [{ _score: { order: 'desc' } }];
  if (lat != null && lng != null) {
    return [
      { _geo_distance: { location: { lat, lon: lng }, order: 'asc', unit: 'km', distance_type: 'plane' } },
      { _score: { order: 'desc' } },
    ];
  }
  return [{ created_at: { order: 'desc' } }];
}

// Daily-stable seed for marker density shuffling (YYYYMMDD).
export function dailySeed(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// Cheap deterministic hash for random_score seeding per viewport+filters.
export function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// Which alias/aliases to query for a given scope.
function indexForScope(scope: string) {
  if (scope === 'both') return [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS];
  if (scope === 'projects') return PROJECTS_INDEX_ALIAS;
  return ES_INDEX_ALIAS;
}

// Price field used for range filtering per scope (projects store low_price).
function priceFieldForScope(scope: string) {
  if (scope === 'both') return 'sort_price';
  if (scope === 'projects') return 'low_price';
  return 'price';
}

// Shared query/filter construction. The sidebar list (queryESListings), the map
// markers (queryESMapMarkers) and the totals all use the SAME filtered
// population, so the list, the badge, and the map dots can never diverge.
function buildFilters(params: any, scope: string): { must: any[]; filters: any[] } {
  const {
    query: rawQuery, location: rawLocation, minPrice, maxPrice, propertyType, bhkType,
    minBedrooms, maxBedrooms,
    listingPurpose, amenities = [], furnishings = [], bathrooms, minArea, maxArea,
    lat, lng, radiusKm, bounds, polygon,
  } = params;

  const query = sanitize(rawQuery)?.toLowerCase().trim();
  const location = sanitize(rawLocation)?.toLowerCase().trim();
  const normalizedAmenities = amenities.map((a: string) => a.toLowerCase().trim());
  const normalizedFurnishings = furnishings.map((f: string) => f.toLowerCase().trim());

  const must: any[] = [];
  const commonFilters: any[] = [];
  const propertyFilters: any[] = [];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: scope === 'both'
          ? ['title^3', 'name^3', 'description^2', 'location_text^2', 'project_name^2', 'developer_name^2']
          : ['title^3', 'description^2', 'location_text^2', 'project_name^2', 'developer_name'],
        type: 'best_fields',
        fuzziness: 'AUTO',
        operator: 'or',
      },
    });
  }

  if (location) {
    must.push({
      multi_match: {
        query: location,
        fields: ['location_text^3', 'title^2', 'name^2', 'project_name^1'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  }

  commonFilters.push({ term: { status: 'available' } });

  if (minPrice || maxPrice) {
    const range: any = {};
    if (minPrice) range.gte = minPrice;
    if (maxPrice) range.lte = maxPrice;
    commonFilters.push({ range: { [priceFieldForScope(scope)]: range } });
  }

  if (propertyType) propertyFilters.push({ term: { property_type: propertyType } });
  if (bhkType) propertyFilters.push({ term: { bhk_type: bhkType } });
  // Generic bedrooms range for bedrooms-model tenants (dual-written by the
  // indexer alongside bhk_type; absent params → no clause → zero behavior change).
  if (minBedrooms != null || maxBedrooms != null) {
    const range: any = {};
    if (minBedrooms != null) range.gte = minBedrooms;
    if (maxBedrooms != null) range.lte = maxBedrooms;
    propertyFilters.push({ range: { bedrooms: range } });
  }
  if (listingPurpose) propertyFilters.push({ term: { listing_purpose: listingPurpose } });
  if (normalizedAmenities.length > 0) propertyFilters.push({ terms: { amenities: normalizedAmenities } });
  if (normalizedFurnishings.length > 0) propertyFilters.push({ terms: { furnishings: normalizedFurnishings } });
  if (bathrooms != null) propertyFilters.push({ range: { bathrooms: { gte: bathrooms } } });
  if (minArea || maxArea) {
    const range: any = {};
    if (minArea) range.gte = minArea;
    if (maxArea) range.lte = maxArea;
    propertyFilters.push({ range: { area_sqft: range } });
  }

  if (lat != null && lng != null) {
    commonFilters.push({ geo_distance: { distance: `${radiusKm || 50}km`, location: { lat, lon: lng } } });
  }

  if (bounds) {
    const { minLat, maxLat, minLng, maxLng } = bounds;
    if (minLat != null && maxLat != null && minLng != null && maxLng != null) {
      commonFilters.push({
        geo_bounding_box: {
          location: { top_left: { lat: maxLat, lon: minLng }, bottom_right: { lat: minLat, lon: maxLng } },
        },
      });
    }
  }

  if (polygon && polygon.length >= 3) {
    commonFilters.push({
      geo_polygon: {
        location: { points: polygon.map((p: any) => ({ lat: p.lat, lon: p.lng })) },
      },
    });
  }

  const filters: any[] = [...commonFilters];
  if (scope === 'both' && propertyFilters.length > 0) {
    filters.push({
      bool: {
        should: [
          { bool: { filter: propertyFilters } },
          { bool: { must_not: { exists: { field: 'bhk_type' } } } },
        ],
        minimum_should_match: 1,
      },
    });
  } else {
    filters.push(...propertyFilters);
  }

  return { must, filters };
}

function buildAggregations(scope: string) {
  // Entity-type counts for the scope badge (properties vs projects).
  const aggs: any = {};
  if (scope === 'both') {
    aggs.by_entity_type = { terms: { field: 'entity_type', size: 5 } };
  }
  // Community rollup for "N New Homes" pills — one lightweight terms agg,
  // cached with the list response. Missing on projects index → empty buckets.
  aggs.by_project = { terms: { field: 'project_name.keyword', size: 20 } };
  return aggs;
}

const LISTING_SOURCE_FIELDS = [
  'id', 'title', 'name', 'slug', 'entity_type',
  'location', 'location_text',
  'price', 'sort_price', 'low_price', 'high_price',
  'area_sqft', 'area_unit',
  'property_type', 'bhk_type', 'bedrooms',
  'bathrooms', 'balconies',
  'cabins', 'workstations', 'min_seats', 'max_seats',
  'furnishing_status', 'listing_purpose', 'listing_purpose_id',
  'image_url', 'primary_image', 'all_images',
  'construction_phase', 'delivery_date', 'developer_name',
  'status', 'project_name',
  'amenities', 'bedrooms_list', 'unit_count',
  'payment_plan_summary', 'construction_progress_percent',
];

// Lightweight fields needed to draw one map dot per listing + hover preview
// without an N+1 fetch (image/specs travel with the tile payload).
const MARKER_SOURCE_FIELDS = [
  'id', 'entity_type', 'location',
  'price', 'sort_price', 'low_price', 'title', 'name',
  'image_url', 'primary_image', 'bhk_type', 'bathrooms', 'balconies',
  'furnishing_status', 'listing_purpose',
  'area_sqft', 'area_unit', 'location_text', 'created_at',
  'developer_name', 'project_name',
];

// Listings newer than this render a "New" badge (computed server-side, no
// per-request date math on the client).
const NEW_LISTING_DAYS = 14;

// Maximum map dots per viewport (Zillow-style cap). This is ONE shared budget
// across properties + projects: a single random-scored query over both indices
// gives every matching doc an equal chance, so dense areas (and the larger
// entity type) naturally get more dots — true density, no per-type quota.
const MARKER_LIMIT = 500;

export async function queryESListings(params: any) {
  const es = getElasticsearchClient();
  const { cursor, pageSize = 24, sort = 'newest', scope = 'both', lat, lng } = params;

  const { must, filters } = buildFilters(params, scope);

  const query = { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } };

  const esQuery: any = {
    index: indexForScope(scope),
    size: pageSize,
    // Exact totals up to 100k for "35,443 results" badges (markers keep false).
    track_total_hits: 100000,
    query,
    sort: buildSortClause(sort, lat, lng, scope),
    aggs: buildAggregations(scope),
    // Only return fields used by the browse page — cuts response size by ~55%
    _source: LISTING_SOURCE_FIELDS,
  };

  if (cursor) esQuery.search_after = cursor;

  const esResponse = await es.search(esQuery);
  const hits = esResponse.hits.hits;

  // Cap amenity arrays at 6 per doc (cards render 3 + "+N more"); the true
  // count travels separately as amenities_total so the label stays honest.
  const results = hits.map((hit: any) => {
    const src = hit._source || {};
    const fullAmenities = Array.isArray(src.amenities) ? src.amenities : [];
    return {
      ...src,
      amenities: fullAmenities.slice(0, 6),
      amenities_total: fullAmenities.length,
      _score: hit._score,
      _sort: hit.sort,
    };
  });

  const total = typeof esResponse.hits.total === 'object' ? esResponse.hits.total.value : esResponse.hits.total || 0;
  const totalRelation = typeof esResponse.hits.total === 'object' ? esResponse.hits.total.relation : undefined;

  let propertyTotal = 0;
  let projectTotal = 0;
  if (scope === 'both') {
    const byEntity = (esResponse.aggregations as any)?.by_entity_type?.buckets || [];
    for (const b of byEntity) {
      if (b.key === 'property') propertyTotal = b.doc_count;
      if (b.key === 'project') projectTotal = b.doc_count;
    }
  } else if (scope === 'projects') {
    projectTotal = total;
  } else {
    propertyTotal = total;
  }

  const projectGroups = ((esResponse.aggregations as any)?.by_project?.buckets || [])
    .filter((b: any) => b.key && String(b.key).trim().length > 0)
    .map((b: any) => ({
      name: b.key,
      count: b.doc_count,
    }));

  return {
    results,
    total,
    totalRelation,
    propertyTotal,
    projectTotal,
    projectGroups,
    nextCursor: results.length >= pageSize ? results[results.length - 1]._sort : null,
  };
}

// Up to MARKER_LIMIT lightweight dots for the map viewport. Density is
// preserved by uniform random sampling (function_score random_score seeded per
// viewport+filters+day): E[n_tile] = budget * p_tile, no per-tile counting,
// no aggregations — fast BKD range scan + Murmur3 scoring.
export async function queryESMapMarkers(params: any) {
  const es = getElasticsearchClient();
  // seedKey identifies the exact normalized viewport+filters being sampled —
  // same view ⇒ same dots within a day (no flicker), different view ⇒ fresh
  // sample. Never a tile id: tile-stable seeds were the stale-dots mechanism.
  const { scope = 'both', seedKey } = params;

  async function run(indexes: string | string[], limit: number, entityType?: string) {
    const { must, filters } = buildFilters(params, scope);
    if (entityType) {
      filters.push({ term: { entity_type: entityType } });
    }

    // Seed is stable within a day for a given viewport+filters (no flicker
    // on re-pan), but varies across viewports/filters/days.
    const seed = (hashSeed(JSON.stringify({ s: seedKey || '', f: filters, m: must })) + dailySeed()) % 2147483647;

    const esQuery: any = {
      index: indexes,
      size: limit,
      track_total_hits: false,
      query: {
        function_score: {
          query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
          functions: [{ random_score: { seed, field: '_seq_no' } }],
          boost_mode: 'replace',
        },
      },
      // No sort — random_score order is the shuffle (saves script-sort CPU).
      _source: MARKER_SOURCE_FIELDS,
    };

    const esResponse = await es.search(esQuery);
    const now = Date.now();
    const newCutoff = now - NEW_LISTING_DAYS * 24 * 3600 * 1000;

    return (esResponse.hits.hits || []).map((hit: any) => {
      const src = hit._source || {};
      const loc = src.location || {};
      const isProject = src.entity_type === 'project';
      const created = src.created_at ? Date.parse(src.created_at) : NaN;
      return {
        id: src.id,
        entity_type: src.entity_type,
        lat: loc.lat ?? null,
        lon: loc.lon ?? null,
        price: isProject ? (src.low_price || 0) : (src.sort_price || src.price || 0),
        title: src.title || src.name || '',
        image_url: src.image_url || src.primary_image || null,
        bhk_type: src.bhk_type || null,
        bathrooms: src.bathrooms ?? null,
        balconies: src.balconies ?? null,
        furnishing_status: src.furnishing_status || null,
        listing_purpose: src.listing_purpose || null,
        area_sqft: src.area_sqft ?? null,
        area_unit: src.area_unit || null,
        location_text: src.location_text || null,
        is_new: Number.isFinite(created) ? created >= newCutoff : false,
      };
    });
  }

  // scope='both' runs ONE query over both aliases with the full 500 budget.
  // Uniform random scores give every matching doc — property or project, dense
  // cluster or sparse village — an equal chance, so the returned dots mirror
  // the true geographic + entity mix (e.g. 103 props + 1270 projects yields
  // ~37 blue + ~463 green dots, not a forced 250/250). Bonus: 1 ES query
  // per pan instead of 2.
  return run(indexForScope(scope), MARKER_LIMIT);
}
