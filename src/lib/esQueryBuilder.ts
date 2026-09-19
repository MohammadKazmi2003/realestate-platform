import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { flags } from '@/lib/flags';

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
  // Entity-type counts for the scope badge (properties vs projects).
  // NOTE: when exactCountCounters is on, totals come from the cheap
  // filter→value_count siblings on the fill/LIST query instead — this terms
  // agg is skipped (it visits all N matches on every pan).
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

// Exact totals without track_total_hits: filter→value_count siblings ride the
// same matching-doc pass the query already performs (one integer increment per
// doc — no heap, no fetch, no ordinals). Cost ≈ +2-5% of the query vs full
// exact counting; exact at every scale (no cap, no truncation, no shard
// pre-trim — unlike grid-bucket sums). `id` is keyword on both indices (the
// pagination tiebreaker sorts on it), so the counter equals doc count.
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
  'developer_name', 'project_name',
  'construction_phase', 'construction_progress_percent', 'delivery_date',
  'amenities', 'amenities_total', 'bedrooms_list', 'unit_count',
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

export async function queryESListings(params: any) {
  const es = getElasticsearchClient();
  const { cursor, pageSize = 24, sort = 'newest', scope = 'both', lat, lng } = params;

  const { must, filters } = buildFilters(params, scope);

  const query = { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } };

  const esQuery: any = {
    index: indexForScope(scope),
    size: pageSize,
    // Exact totals now come from filter→value_count siblings below (cheap
    // counters riding the same matching-doc pass — exact at every scale).
    // track_total_hits stays off: legacy capped counting (even 10K) is pure
    // overhead once counters exist. Reversible via flags.exactCountCounters.
    track_total_hits: flags.exactCountCounters ? false : (flags.listCap10K ? flags.listTrackCap : 100000),
    query,
    sort: buildSortClause(sort, lat, lng, scope),
    aggs: {
      ...buildAggregations(scope, flags.exactCountCounters),
      ...(flags.exactCountCounters ? buildExactCountAggs(must, filters) : {}),
    },
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

  // Exact badge totals from the counter siblings when present (always eq —
  // counters have no cap, truncation, or shard pre-trim). Falls back to the
  // legacy capped/terms path when the flag is off or aggs are missing.
  const exact = readExactCount((esResponse as any).aggregations);
  const exactTotal = exact != null ? exact.total : total;
  const exactRelation = exact != null ? 'eq' : totalRelation;

  let propertyTotal = 0;
  let projectTotal = 0;
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
    projectTotal = exactTotal;
  } else {
    propertyTotal = exactTotal;
  }

  const projectGroups = ((esResponse.aggregations as any)?.by_project?.buckets || [])
    .filter((b: any) => b.key && String(b.key).trim().length > 0)
    .map((b: any) => ({
      name: b.key,
      count: b.doc_count,
    }));

  // Intent-aware empty state: when a purpose filter zeroes results, one cheap
  // count-only retry without it tells the UI "N available under other intents"
  // instead of a dead-end "No results". Runs ONLY on empty (no cost otherwise).
  // Gated on the exact total so the capped/legacy path behaves identically.
  let withoutPurposeTotal: number | null = null;
  if (exactTotal === 0 && typeof params?.listingPurpose === 'string' && params.listingPurpose.trim()) {
    try {
      const relaxed = buildFilters({ ...params, listingPurpose: undefined }, scope);
      const countRes: any = await es.count({
        index: indexForScope(scope),
        query: {
          bool: {
            must: relaxed.must.length > 0 ? relaxed.must : [{ match_all: {} }],
            filter: relaxed.filters,
          },
        },
      });
      withoutPurposeTotal = typeof countRes.count === 'number' ? countRes.count : null;
    } catch {
      withoutPurposeTotal = null;
    }
  }

  return {
    results,
    total: exactTotal,
    totalRelation: exactRelation,
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
        developer_name: src.developer_name || null,
        project_name: src.project_name || null,
        construction_phase: src.construction_phase || null,
        construction_progress_percent: src.construction_progress_percent ?? null,
        delivery_date: src.delivery_date || null,
        amenities: fullAmenities.slice(0, 6),
        amenities_total: fullAmenities.length,
        bedrooms_list: Array.isArray(src.bedrooms_list) ? src.bedrooms_list : [],
        unit_count: src.unit_count ?? null,
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
