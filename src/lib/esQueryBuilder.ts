import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';

function sanitize(s: string | undefined, maxLen = 200): string | undefined {
  if (!s) return s;
  if (s.length > maxLen) return s.slice(0, maxLen);
  if (/(.)\1{10,}/.test(s)) return s.slice(0, 50);
  return s;
}

function buildSortClause(sort: string, lat?: number, lng?: number, scope?: string) {
  if (scope === 'both') {
    if (sort === 'price_asc') {
      return [
        { _script: { type: 'number', script: { source: "doc['sort_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
        { sort_price: { order: 'asc' } },
        { _score: { order: 'desc' } },
      ];
    }
    if (sort === 'price_desc') {
      return [
        { _script: { type: 'number', script: { source: "doc['sort_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
        { sort_price: { order: 'desc' } },
        { _score: { order: 'desc' } },
      ];
    }
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
    if (sort === 'popular') return [{ _score: { order: 'desc' } }];
    return [
      { _script: { type: 'number', script: { source: "doc['sort_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
      { _score: { order: 'desc' } },
    ];
  }
  if (scope === 'projects') {
    if (sort === 'price_asc') return [{ low_price: { order: 'asc' } }, { _score: { order: 'desc' } }];
    if (sort === 'price_desc') return [{ low_price: { order: 'desc' } }, { _score: { order: 'desc' } }];
    if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
    return [
      { _script: { type: 'number', script: { source: "doc['low_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
      { _score: { order: 'desc' } },
    ];
  }
  if (sort === 'price_asc') return [{ price: { order: 'asc' } }, { _score: { order: 'desc' } }];
  if (sort === 'price_desc') return [{ price: { order: 'desc' } }, { _score: { order: 'desc' } }];
  if (sort === 'newest') return [{ created_at: { order: 'desc' } }];
  if (lat != null && lng != null) {
    return [
      { _geo_distance: { location: { lat, lon: lng }, order: 'asc', unit: 'km', distance_type: 'plane' } },
      { _score: { order: 'desc' } },
    ];
  }
  return [
    { _script: { type: 'number', script: { source: "doc['price'].value == 0 ? 1 : 0" }, order: 'asc' } },
    { _score: { order: 'desc' } },
  ];
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
  return aggs;
}

const LISTING_SOURCE_FIELDS = [
  'id', 'title', 'name', 'slug', 'entity_type',
  'location', 'location_text',
  'price', 'sort_price', 'low_price', 'high_price',
  'area_sqft', 'area_unit',
  'property_type', 'bhk_type',
  'bathrooms', 'balconies',
  'image_url', 'primary_image', 'all_images',
  'construction_phase', 'delivery_date', 'developer_name',
  'status', 'project_name',
];

// Lightweight fields needed to draw one map dot per listing.
const MARKER_SOURCE_FIELDS = [
  'id', 'entity_type', 'location',
  'price', 'sort_price', 'low_price', 'title', 'name',
];

// Maximum map dots per viewport (Zillow-style cap).
const MARKER_LIMIT = 500;
// When scope='both', split the marker budget between the two entity types so
// one type can never crowd out the other (e.g. 1270 projects vs 103 properties
// at a country-level viewport would otherwise fill all 500 slots with projects).
const MARKER_SPLIT = 250;

export async function queryESListings(params: any) {
  const es = getElasticsearchClient();
  const { cursor, pageSize = 24, sort = 'relevance', scope = 'both', lat, lng } = params;

  const { must, filters } = buildFilters(params, scope);

  const esQuery: any = {
    index: indexForScope(scope),
    size: pageSize,
    query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
    sort: buildSortClause(sort, lat, lng, scope),
    aggs: buildAggregations(scope),
    // Only return fields used by the browse page — cuts response size by ~55%
    _source: LISTING_SOURCE_FIELDS,
  };

  if (cursor) esQuery.search_after = cursor;

  const esResponse = await es.search(esQuery);
  const hits = esResponse.hits.hits;

  const results = hits.map((hit: any) => ({
    ...hit._source,
    _score: hit._score,
    _sort: hit.sort,
  }));

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

  return {
    results,
    total,
    totalRelation,
    propertyTotal,
    projectTotal,
    nextCursor: results.length >= pageSize ? results[results.length - 1]._sort : null,
  };
}

// Up to MARKER_LIMIT lightweight dots for the map viewport. Same filters and
// sort as the sidebar list so dots match the list ordering. No scoring cost
// beyond the bbox (filter context) and no aggregations — fast BKD range scan.
export async function queryESMapMarkers(params: any) {
  const es = getElasticsearchClient();
  const { sort = 'relevance', scope = 'both', lat, lng } = params;

  async function run(indexes: string | string[], limit: number, entityType?: string) {
    const { must, filters } = buildFilters(params, scope);
    if (entityType) {
      filters.push({ term: { entity_type: entityType } });
    }

    const esQuery: any = {
      index: indexes,
      size: limit,
      track_total_hits: false,
      query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
      sort: buildSortClause(sort, lat, lng, scope),
      _source: MARKER_SOURCE_FIELDS,
    };

    const esResponse = await es.search(esQuery);

    return (esResponse.hits.hits || []).map((hit: any) => {
      const src = hit._source || {};
      const loc = src.location || {};
      const isProject = src.entity_type === 'project';
      return {
        id: src.id,
        entity_type: src.entity_type,
        lat: loc.lat ?? null,
        lon: loc.lon ?? null,
        price: isProject ? (src.low_price || 0) : (src.sort_price || src.price || 0),
        title: src.title || src.name || '',
      };
    });
  }

  if (scope === 'both') {
    // Two capped queries so both property AND project dots always render.
    const [properties, projects] = await Promise.all([
      run([ES_INDEX_ALIAS], MARKER_SPLIT, 'property'),
      run([PROJECTS_INDEX_ALIAS], MARKER_SPLIT, 'project'),
    ]);
    return [...properties, ...projects];
  }

  return run(indexForScope(scope), MARKER_LIMIT);
}
