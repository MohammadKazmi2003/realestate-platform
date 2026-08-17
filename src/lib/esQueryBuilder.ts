import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';

function sanitize(s: string | undefined, maxLen = 200): string | undefined {
  if (!s) return s;
  if (s.length > maxLen) return s.slice(0, maxLen);
  if (/(.)\1{10,}/.test(s)) return s.slice(0, 50);
  return s;
}

function roundBounds(b: any) {
  if (!b) return b;
  return {
    minLat: Math.round(b.minLat * 100) / 100,
    maxLat: Math.round(b.maxLat * 100) / 100,
    minLng: Math.round(b.minLng * 100) / 100,
    maxLng: Math.round(b.maxLng * 100) / 100,
  };
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

// Map geotile precision from zoom. The same query that feeds the sidebar list
// also produces the map cluster circles, so list + map can never diverge.
export function zoomToPrecision(zoom: number): number {
  if (zoom <= 5) return 2;
  if (zoom <= 8) return 3;
  if (zoom <= 11) return 4;
  if (zoom <= 13) return 5;
  return 6;
}

// scaled_float (×100) metric aggregations return raw scaled values — divide
// by the scaling factor to get real prices (matches es-config mappings).
const PRICE_SCALING = 100;

function buildAggregations(scope: string, zoom?: number, bounds?: any) {
  // Map-data endpoint only needs entity-type counts for scope='both'.
  // Facet aggregations (property_type, bhk, amenities, etc.) are not used
  // by the browse page — they add 50-200ms of ES CPU time for no benefit.
  const aggs: any = {};
  if (scope === 'both') {
    aggs.by_entity_type = { terms: { field: 'entity_type', size: 5 } };
  }
  // Map clusters: geotile_grid geographic bucketing over the SAME filtered
  // docs the list shows (all filters + viewport are applied in the query
  // itself — never post-filtered). bounds restricts bucketing to the
  // viewport so sum(buckets) == viewport total by construction.
  if (zoom != null && bounds?.minLat != null) {
    aggs.clusters = {
      geotile_grid: {
        field: 'location',
        precision: zoomToPrecision(zoom),
        bounds: {
          top_left: { lat: bounds.maxLat, lon: bounds.minLng },
          bottom_right: { lat: bounds.minLat, lon: bounds.maxLng },
        },
      },
      aggs: {
        center: { geo_centroid: { field: 'location' } },
        avg_price: { avg: { field: 'sort_price' } },
        min_price: { min: { field: 'sort_price' } },
        max_price: { max: { field: 'sort_price' } },
        by_type: { terms: { field: 'entity_type', size: 5 } },
      },
    };
  }
  return aggs;
}

export async function queryESListings(params: any) {
  const es = getElasticsearchClient();
  const {
    query: rawQuery, location: rawLocation, minPrice, maxPrice, propertyType, bhkType,
    listingPurpose, amenities = [], furnishings = [], bathrooms, minArea, maxArea,
    lat, lng, radiusKm, bounds, polygon, cursor, pageSize = 24, sort = 'relevance', scope = 'both',
    zoom,
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
    commonFilters.push({ range: { [scope === 'both' ? 'sort_price' : 'price']: range } });
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

  const esQuery: any = {
    index: scope === 'both' ? [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS] : ES_INDEX_ALIAS,
    size: pageSize,
    query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
    sort: buildSortClause(sort, lat, lng, scope),
    aggs: buildAggregations(scope, zoom, bounds),
    // Only return fields used by the browse page — cuts response size by ~55%
    _source: [
      'id', 'title', 'name', 'slug', 'entity_type',
      'location', 'location_text',
      'price', 'sort_price', 'low_price', 'high_price',
      'area_sqft', 'area_unit',
      'property_type', 'bhk_type',
      'bathrooms', 'balconies',
      'image_url', 'primary_image', 'all_images',
      'construction_phase', 'delivery_date', 'developer_name',
      'status', 'project_name',
    ],
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
  } else {
    propertyTotal = total;
  }

  return {
    results,
    total,
    totalRelation,
    clusters: parseClusterBuckets((esResponse.aggregations as any)?.clusters?.buckets),
    precision: zoom != null ? zoomToPrecision(zoom) : undefined,
    propertyTotal,
    projectTotal,
    nextCursor: results.length >= pageSize ? results[results.length - 1]._sort : null,
    aggregations: esResponse.aggregations || {},
  };
}

// Map clusters: geotile_grid buckets → lightweight {tile, lat, lon, count, price stats, types}.
// Rendered as cluster circles by the browse map. No heavy documents shipped.
export function parseClusterBuckets(buckets: any[]): any[] {
  return (buckets || []).map((bucket: any) => {
    const center = bucket.center?.location;
    const types = (bucket.by_type?.buckets || []).reduce((acc: any, b: any) => {
      acc[b.key] = b.doc_count;
      return acc;
    }, {});
    return {
      tile: bucket.key,
      lat: center?.lat ?? 0,
      lon: center?.lon ?? 0,
      count: bucket.doc_count || 0,
      avg_price: Math.round((bucket.avg_price?.value || 0) / PRICE_SCALING),
      min_price: Math.round((bucket.min_price?.value || 0) / PRICE_SCALING),
      max_price: Math.round((bucket.max_price?.value || 0) / PRICE_SCALING),
      types,
    };
  });
}
