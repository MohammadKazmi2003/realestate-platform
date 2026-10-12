import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { flags } from '@/lib/flags';
import { buildFilterHash64, redisTTLForSort } from '@/lib/mapTiles';
import { singleflightCompute } from '@/lib/redis';

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
    // Bedroom/bathroom/area sorts use the property scalar fields. Project docs
    // lack these fields, so they sink via missing:_last (documented: mixed
    // both-scope sorts rank properties first, projects last). unmapped_type is
    // required: without it ES fails the shard with "No mapping found ... in
    // order to sort on" (projects index has no such field, dynamic:false).
    if (sort === 'beds') {
      return [
        { bedrooms: { order: 'desc', missing: '_last', unmapped_type: 'integer' } },
        { _score: { order: 'desc' } },
      ];
    }
    if (sort === 'baths') {
      return [
        { bathrooms: { order: 'desc', missing: '_last', unmapped_type: 'integer' } },
        { _score: { order: 'desc' } },
      ];
    }
    // sqft + lot both order by area_sqft (no separate lot field exists;
    // area_sqft folds carpet/built-up/super-built-up/plot — documented).
    if (sort === 'sqft' || sort === 'lot') {
      return [
        { area_sqft: { order: 'desc', missing: '_last', unmapped_type: 'float' } },
        { _score: { order: 'desc' } },
      ];
    }
    // Unknown sort values fall back to newest (honest default).
    return [{ created_at: { order: 'desc' } }];
  }
  if (scope === 'projects') {
    if (sort === 'price_asc') return [{ low_price: { order: 'asc', missing: '_last' } }, { _score: { order: 'desc' } }];
    if (sort === 'price_desc') return [{ low_price: { order: 'desc', missing: '_last' } }, { _score: { order: 'desc' } }];
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
    if (sort === 'popular') return [{ _score: { order: 'desc' } }];
    // Projects store bedroom options as bedrooms_list (int[]); min mode ranks
    // by smallest unit. Baths/sqft/lot have no project scalar — documented
    // fallback to newest so the map still shifts recency-wise.
    if (sort === 'beds') return [{ bedrooms_list: { order: 'desc', mode: 'min', missing: '_last' } }, { _score: { order: 'desc' } }];
    if (sort === 'baths' || sort === 'sqft' || sort === 'lot') return [{ created_at: { order: 'desc' } }];
    return [{ created_at: { order: 'desc' } }];
  }
  if (sort === 'price_asc') return [{ price: { order: 'asc', missing: '_last' } }, { _score: { order: 'desc' } }];
  if (sort === 'price_desc') return [{ price: { order: 'desc', missing: '_last' } }, { _score: { order: 'desc' } }];
  if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
  if (sort === 'popular') return [{ _score: { order: 'desc' } }];
  if (sort === 'beds') return [{ bedrooms: { order: 'desc', missing: '_last' } }, { _score: { order: 'desc' } }];
  if (sort === 'baths') return [{ bathrooms: { order: 'desc', missing: '_last' } }, { _score: { order: 'desc' } }];
  if (sort === 'sqft' || sort === 'lot') return [{ area_sqft: { order: 'desc', missing: '_last' } }, { _score: { order: 'desc' } }];
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
export function indexForScope(scope: string) {
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
export function buildFilters(params: any, scope: string): { must: any[]; filters: any[] } {
  const {
    query: rawQuery, location: rawLocation, minPrice, maxPrice, propertyType, bhkType,
    minBedrooms, maxBedrooms,
    listingPurpose, amenities = [], furnishings = [], bathrooms, minArea, maxArea,
    lat, lng, radiusKm, bounds, polygon, polygons,
  } = params;

  // Pincode/number groups (e.g. "Panvel, 410 206") never exist in flat
  // location_text values — strip 3+ digit runs so they can't dilute matching.
  const stripNumbers = (s: string | undefined): string | undefined => {
    if (!s) return s;
    const t = s.replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
    return t.length > 0 ? t : undefined;
  };
  const query = stripNumbers(sanitize(rawQuery)?.toLowerCase().trim());
  const location = stripNumbers(sanitize(rawLocation)?.toLowerCase().trim());
  const normalizedAmenities = amenities.map((a: string) => a.toLowerCase().trim());
  const normalizedFurnishings = furnishings.map((f: string) => f.toLowerCase().trim());

  const must: any[] = [];
  const commonFilters: any[] = [];
  const propertyFilters: any[] = [];

  // Exact-ring boundary: a listing inside ANY ring of the selected entity
  // matches (mainland or explicitly selected island). Single-ring legacy
  // `polygon` is wrapped for the same code path. Computed early because text
  // clauses demote to scoring-only whenever rings are present.
  const boundaryRings: any[][] = Array.isArray(polygons)
    ? polygons.filter((r: any) => Array.isArray(r) && r.length >= 3)
    : Array.isArray(polygon) && polygon.length >= 3
      ? [polygon]
      : [];
  const hasBoundary = boundaryRings.length > 0;

  // Text clauses filter ONLY when no boundary is present. With exact rings,
  // geography is the filter (small places often lack text tokens entirely)
  // and text merely boosts genuinely matching titles.
  const textClauses: any[] = [];
  if (query) {
    textClauses.push({
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
    textClauses.push({
      multi_match: {
        query: location,
        fields: ['location_text^3', 'title^2', 'name^2', 'project_name^1'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  }
  if (textClauses.length > 0) {
    if (hasBoundary) {
      must.push({ bool: { should: textClauses, minimum_should_match: 0 } });
    } else {
      must.push(...textClauses);
    }
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
  // Normalize intent labels: 'Sale'↔'Sell' collapse so legacy docs + PG drift
  // can't silently return 0 hits. Buy matches both variants.
  const normalizedPurpose = (() => {
    if (typeof listingPurpose !== 'string') return undefined;
    const t = listingPurpose.trim().toLowerCase();
    if (!t) return undefined;
    if (t === 'sell' || t === 'sale') return '__sale__';
    return t;
  })();
  const isRentLikeIntent =
    typeof listingPurpose === 'string' && /rent|lease|\bpg\b/i.test(listingPurpose);
  // Generic bedrooms range for bedrooms-model tenants (dual-written by the
  // indexer alongside bhk_type; absent params → no clause → zero behavior change).
  if (minBedrooms != null || maxBedrooms != null) {
    const range: any = {};
    if (minBedrooms != null) range.gte = minBedrooms;
    if (maxBedrooms != null) range.lte = maxBedrooms;
    propertyFilters.push({ range: { bedrooms: range } });
  }
  if (normalizedPurpose === '__sale__') {
    propertyFilters.push({ terms: { listing_purpose: ['Sell', 'Sale'] } });
  } else if (normalizedPurpose) {
    propertyFilters.push({ term: { listing_purpose: listingPurpose } });
  }
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

  if (boundaryRings.length === 1) {
    commonFilters.push({
      geo_polygon: {
        location: { points: boundaryRings[0].map((p: any) => ({ lat: p.lat, lon: p.lng })) },
      },
    });
  } else if (boundaryRings.length > 1) {
    commonFilters.push({
      bool: {
        should: boundaryRings.map((ring: any[]) => ({
          geo_polygon: {
            location: { points: ring.map((p: any) => ({ lat: p.lat, lon: p.lng })) },
          },
        })),
        minimum_should_match: 1,
      },
    });
  }

  // Rent-like intents (Rent/Lease/PG) are property-only: projects are
  // for-sale inventory. Excluding at filter level keeps one query, one
  // population for list/badge/markers (no app-side post-filter).
  if (isRentLikeIntent) {
    commonFilters.push({ bool: { must_not: { term: { entity_type: 'project' } } } });
  }

  // Single scope must constrain entity_type EXPLICITLY. It used to be implied
  // by picking one index per scope, but tile queries now hit the unified
  // listings_tile index which holds both kinds — without this, scope=properties
  // silently returned project markers (caught by scope test in scale:e2e).
  // Redundant on the legacy split indices (a cheap filtered term) and required
  // on the unified one, so the population stays correct for either path.
  if (scope === 'properties') {
    commonFilters.push({ term: { entity_type: 'property' } });
  } else if (scope === 'projects') {
    commonFilters.push({ term: { entity_type: 'project' } });
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

function buildAggregations(scope: string, noEntityCounts = false) {
  // Entity-type counts for the scope badge (properties vs projects). With
  // native counts (default) this is the cheapest exact split — one ordinal
  // pass on a 2-value keyword — so it is INCLUDED on the list path. Only the
  // counter fallback skips it (it derives the split from value_count siblings).
  const aggs: any = {};
  if (scope === 'both' && !noEntityCounts) {
    aggs.by_entity_type = { terms: { field: 'entity_type', size: 5 } };
  }
  // Community rollup for "N New Homes" pills — LAZY by default (flags.lazyPills):
  // skipped on the list critical path (~15-20% CPU at 10M docs: terms over all
  // N matches + ordinals). Client fetches /api/project-groups separately with
  // its own long-TTL cache. Set LAZY_PILLS=0 to restore inline pills.
  let lazy = true;
  try {
    lazy = flags.lazyPills;
  } catch {
    lazy = process.env.LAZY_PILLS !== '0';
  }
  if (!lazy) {
    aggs.by_project = { terms: { field: 'project_name.keyword', size: 20 } };
  }
  return aggs;
}

// Exact totals without track_total_hits: filter→value_count siblings re-evaluate
// the full base filter per counter. Kept only as the NATIVE_COUNTS=0 fallback —
// measured ~2.6x slower than native counting at 100k/1M (see flags.nativeCounts).
function buildExactCountAggs(must: any[], filters: any[]) {
  const scoped = (extra: any) => ({
    filter: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: [...filters, extra] } },
    aggs: { total: { value_count: { field: 'id' } } },
  });
  return {
    // Un-narrowed viewport population — deliberately built from base filters
    // WITHOUT any quantileRange (counting the narrowed set would ratchet).
    exact_total: {
      filter: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
      aggs: { total: { value_count: { field: 'id' } } },
    },
    exact_property: scoped({ term: { entity_type: 'property' } }),
    exact_project: scoped({ term: { entity_type: 'project' } }),
  };
}

function readExactCount(aggregations: any): { total: number; property: number; project: number } | null {
  try {
    const t = aggregations?.exact_total?.total?.value;
    const p = aggregations?.exact_property?.total?.value;
    const j = aggregations?.exact_project?.total?.value;
    if (typeof t !== 'number' || typeof p !== 'number' || typeof j !== 'number') return null;
    return { total: t, property: p, project: j };
  } catch {
    return null;
  }
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
// ALSO carries the full click-card preview payload (amenities, price range,
// project extras): clicking a dot renders the FINAL card immediately with no
// follow-up fetch for text content — the click fetch only tops up the photo
// gallery. ~330B/marker raw (~25-40KB gzipped per 500-dot viewport, cached).
const MARKER_SOURCE_FIELDS = [
  'id', 'entity_type', 'location',
  'price', 'sort_price', 'low_price', 'high_price', 'title', 'name',
  'image_url', 'primary_image', 'bhk_type', 'bathrooms', 'balconies',
  'furnishing_status', 'listing_purpose', 'property_type',
  'area_sqft', 'area_unit', 'location_text', 'created_at',
  'developer_name',
  'construction_phase', 'construction_progress_percent', 'delivery_date',
  'amenities', 'amenities_total', 'bedrooms_list',
  'payment_plan_summary', 'image_count',
];

// Listings newer than this render a "New" badge (computed server-side, no
// per-request date math on the client).
const NEW_LISTING_DAYS = 14;

// Maximum map dots per viewport (Zillow-style cap). This is ONE shared budget
// across properties + projects: a single random-scored query over both indices
// gives every matching doc an equal chance, so dense areas (and the larger
// entity type) naturally get more dots — true density, no per-type quota.
const MARKER_LIMIT = 500;

// --- Split counts (SPLIT_COUNTS) ---
//
// Measured (live ES, 1M corpus, cache-controlled): exact counting costs
// +32-68ms when attached to a size:24 query (the top-k collector counts every
// match) but 0-10ms as a size:0 request (Lucene's sub-linear Weight.count
// path). The list query therefore runs track_total_hits:false and counts come
// from the functions below, cached and coalesced across instances.
//
// The count cache key is the FILTER POPULATION ONLY — no cursor, sort, or
// pageSize — because counts are page- and sort-invariant. That makes every
// paginated page and every re-sort of the same population reuse one count
// instead of recomputing it (the list response cache key includes cursor+sort,
// so it cannot provide that reuse).
export function buildCountCacheKey(must: any[], filters: any[]): string {
  return `md:v5:c:${buildFilterHash64({ must, filters } as Record<string, any>)}`;
}

export function buildCountQuery(must: any[], filters: any[], scope: string): any {
  const aggs: any = {};
  // Exact property/project split in the same count pass (one ordinal pass on a
  // 2-value keyword). Only meaningful when both entity types are queried.
  if (scope === 'both') aggs.by_entity_type = { terms: { field: 'entity_type', size: 2 } };
  return {
    index: indexForScope(scope),
    size: 0,
    track_total_hits: true,
    query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
    ...(Object.keys(aggs).length > 0 ? { aggs } : {}),
    // The shard request cache only serves size:0 requests. The JS client
    // hoists this to the URL query string (raw-body callers must not).
    request_cache: true,
  };
}

export function parseListingCounts(
  res: any,
  scope: string
): { total: number; totalRelation?: string; propertyTotal: number; projectTotal: number } {
  const h = res?.hits?.total;
  const total = typeof h === 'object' ? h.value : typeof h === 'number' ? h : 0;
  const totalRelation = typeof h === 'object' ? h.relation : undefined;
  let propertyTotal = 0;
  let projectTotal = 0;
  if (scope === 'both') {
    for (const b of res?.aggregations?.by_entity_type?.buckets || []) {
      if (b.key === 'property') propertyTotal = b.doc_count;
      if (b.key === 'project') projectTotal = b.doc_count;
    }
  } else if (scope === 'projects') {
    projectTotal = total;
  } else {
    propertyTotal = total;
  }
  return { total, totalRelation, propertyTotal, projectTotal };
}

// Counts for an already-built population (AD3: callers pass the same
// must/filters they query with). Redis-cached under the population key and
// coalesced across instances; failures are never cached and degrade to one
// uncached attempt rather than hiding the count.
export async function getListingCountsFor(must: any[], filters: any[], scope: string, sort?: string) {
  const es = getElasticsearchClient();
  const run = async () => {
    const res: any = await es.search(buildCountQuery(must, filters, scope));
    return parseListingCounts(res, scope);
  };
  const key = buildCountCacheKey(must, filters);
  // Tiered TTL so counts expire with the ordering tier they are read beside —
  // a count must never outlive the list population it describes by much.
  const ttl = redisTTLForSort(sort);
  try {
    const { value } = await singleflightCompute(key, ttl, run);
    if (value) return value;
  } catch {
    /* fall through to the uncached attempt below */
  }
  return run();
}

export async function getListingCounts(params: any, scope: string) {
  const { must, filters } = buildFilters(params, scope);
  return getListingCountsFor(must, filters, scope, params?.sort);
}

// List query plan (pure — exported for tests and benchmarks). Counting strategy
// is selected HERE so every list surface (browse sidebar via /api/map-data,
// /api/search) shares one implementation.
//
// Measured on live ES (100k and 1M synthetic corpora, cache-controlled):
//   counters (3x filter→value_count)  218ms  @1M all-matches
//   native inline (tth:true + terms)   83ms  @1M all-matches
//   split count (size:0, cached)        1-10ms per count
// Each counter re-evaluates the full base filter; a top-k collector counts
// every match; a count-only request uses Lucene's sub-linear Weight.count path.
// Exact at every scale.
export function buildListQuery(params: any) {
  const { cursor, pageSize = 24, sort = 'newest', scope = 'both', lat, lng } = params;

  const { must, filters } = buildFilters(params, scope);

  const query = { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } };

  const split = flags.splitCounts;
  const native = flags.nativeCounts;
  const esQuery: any = {
    index: indexForScope(scope),
    size: pageSize,
    // Split: counts travel separately (getListingCountsFor) so this query never
    // counts. Inline: exact via tth:true, or the counter/capped fallbacks.
    track_total_hits: split
      ? false
      : native
        ? true
        : (flags.exactCountCounters ? false : (flags.listCap10K ? flags.listTrackCap : 100000)),
    query,
    sort: buildSortClause(sort, lat, lng, scope),
    aggs: split
      ? buildAggregations(scope, true)
      : native
        ? buildAggregations(scope, false)
        : {
            ...buildAggregations(scope, flags.exactCountCounters),
            ...(flags.exactCountCounters ? buildExactCountAggs(must, filters) : {}),
          },
    // Only return fields used by the browse page — cuts response size by ~55%
    _source: LISTING_SOURCE_FIELDS,
  };

  if (cursor) esQuery.search_after = cursor;
  return esQuery;
}

export async function queryESListings(params: any) {
  const es = getElasticsearchClient();
  const { pageSize = 24, scope = 'both' } = params;

  const split = flags.splitCounts;
  const esQuery = buildListQuery(params);
  // Split mode: the list query does not count; counts come from the cached,
  // cross-instance coalesced count request for the same population (AD3 — same
  // buildFilters). Run both in parallel so a cold request pays max(list, count)
  // rather than their sum; a cached count costs one Redis read.
  const countPromise = split
    ? (() => {
        const { must, filters } = buildFilters(params, scope);
        return getListingCountsFor(must, filters, scope, params.sort);
      })()
    : Promise.resolve(null);

  const [esResponse, counts] = await Promise.all([es.search(esQuery), countPromise]);
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

  let total: number;
  let totalRelation: string | undefined;
  let propertyTotal = 0;
  let projectTotal = 0;
  if (split && counts) {
    // Split mode: exact counts from the cached count request (relation 'eq' —
    // uncapped, no shard pre-trim). The list query never counted.
    total = counts.total;
    totalRelation = counts.totalRelation;
    propertyTotal = counts.propertyTotal;
    projectTotal = counts.projectTotal;
  } else {
    // Inline mode (SPLIT_COUNTS=0): native path reads the exact `hits.total`
    // (tth:true, relation 'eq') and the property/project split from
    // by_entity_type; the NATIVE_COUNTS=0 fallback reads the counter siblings
    // (also exact, just slower). Both are exact at every scale — no cap,
    // truncation, or shard pre-trim.
    total = typeof esResponse.hits.total === 'object' ? esResponse.hits.total.value : esResponse.hits.total || 0;
    totalRelation = typeof esResponse.hits.total === 'object' ? esResponse.hits.total.relation : undefined;
    const exact = readExactCount((esResponse as any).aggregations);
    total = exact != null ? exact.total : total;
    totalRelation = exact != null ? 'eq' : totalRelation;

    if (scope === 'both') {
      if (exact != null) {
        propertyTotal = exact.property;
        projectTotal = exact.project;
      } else {
        const byEntity = (esResponse.aggregations as any)?.by_entity_type?.buckets || [];
        for (const b of byEntity) {
          if (b.key === 'property') propertyTotal = b.doc_count;
          if (b.key === 'project') projectTotal = b.doc_count;
        }
      }
    } else if (scope === 'projects') {
      projectTotal = total;
    } else {
      propertyTotal = total;
    }
  }

  const projectGroups = ((esResponse.aggregations as any)?.by_project?.buckets || [])
    .filter((b: any) => b.key && String(b.key).trim().length > 0)
    .map((b: any) => ({
      name: b.key,
      count: b.doc_count,
    }));

  // Intent-aware empty state: when a purpose filter zeroes results, one cheap
  // count-only retry without it tells the UI "N available under other intents"
  // instead of a dead-end "No results". Runs ONLY on empty (no cost otherwise)
  // and rides the same cached/coalesced count path as every other count.
  let withoutPurposeTotal: number | null = null;
  if (total === 0 && typeof params?.listingPurpose === 'string' && params.listingPurpose.trim()) {
    try {
      const relaxed = buildFilters({ ...params, listingPurpose: undefined }, scope);
      const relaxedCounts = await getListingCountsFor(relaxed.must, relaxed.filters, scope, params.sort);
      withoutPurposeTotal = typeof relaxedCounts?.total === 'number' ? relaxedCounts.total : null;
    } catch {
      withoutPurposeTotal = null;
    }
  }

  return {
    results,
    total,
    totalRelation,
    propertyTotal,
    projectTotal,
    projectGroups,
    nextCursor: results.length >= pageSize ? results[results.length - 1]._sort : null,
    withoutPurposeTotal,
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
      // Card preview payload: amenities capped at 6 (card shows 3 + "+N
      // more"); true count travels separately so the label stays honest.
      const fullAmenities = Array.isArray(src.amenities) ? src.amenities : [];
      return {
        id: src.id,
        entity_type: src.entity_type,
        lat: loc.lat ?? null,
        lon: loc.lon ?? null,
        price: isProject ? (src.low_price || 0) : (src.sort_price || src.price || 0),
        low_price: src.low_price ?? null,
        high_price: src.high_price ?? null,
        title: src.title || src.name || '',
        image_url: src.image_url || src.primary_image || null,
        bhk_type: src.bhk_type || null,
        bathrooms: src.bathrooms ?? null,
        balconies: src.balconies ?? null,
        furnishing_status: src.furnishing_status || null,
        listing_purpose: src.listing_purpose || null,
        property_type: src.property_type || null,
        area_sqft: src.area_sqft ?? null,
        area_unit: src.area_unit || null,
        location_text: src.location_text || null,
        is_new: Number.isFinite(created) ? created >= newCutoff : false,
        // Internal rank key for newest-sort strides — stripped before respond.
        _createdMs: Number.isFinite(created) ? created : null,
        developer_name: src.developer_name || null,
        construction_phase: src.construction_phase || null,
        construction_progress_percent: src.construction_progress_percent ?? null,
        delivery_date: src.delivery_date || null,
        amenities: fullAmenities.slice(0, 6),
        amenities_total: fullAmenities.length,
        bedrooms_list: Array.isArray(src.bedrooms_list) ? src.bedrooms_list : [],
        payment_plan_summary: src.payment_plan_summary || null,
        image_count: typeof src.image_count === 'number' ? src.image_count : null,
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

// Lazy pills: standalone by_project terms agg (size:0, no hits) so the list
// critical path skips it. Same filtered population as queryESListings via
// buildFilters — same bounds+filters, own long-TTL cache key in the route.
// request_cache:true + track_total_hits:false; cheap at every scale.
export async function queryESProjectGroups(params: any, scope = 'both') {
  const es = getElasticsearchClient();
  const { must, filters } = buildFilters(params, scope);
  const res: any = await es.search({
    index: indexForScope(scope),
    size: 0,
    track_total_hits: false,
    query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
    aggs: { by_project: { terms: { field: 'project_name.keyword', size: 20 } } },
    request_cache: true,
  } as any);
  return ((res?.aggregations as any)?.by_project?.buckets || [])
    .filter((b: any) => b.key && String(b.key).trim().length > 0)
    .map((b: any) => ({ name: b.key, count: b.doc_count }));
}
