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
    return [{ _score: { order: 'desc' } }];
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
  return [{ _score: { order: 'desc' } }];
}

function buildAggregations(scope: string) {
  if (scope === 'both') {
    return { by_entity_type: { terms: { field: 'entity_type', size: 5 } } };
  }
  return {
    by_property_type: { terms: { field: 'property_type', size: 20 } },
    by_bhk: { terms: { field: 'bhk_type', size: 10 } },
    by_listing_purpose: { terms: { field: 'listing_purpose', size: 10 } },
    by_furnishing: { terms: { field: 'furnishing_status', size: 10 } },
    by_amenities: { terms: { field: 'amenities', size: 50 } },
    price_stats: { stats: { field: 'price' } },
  };
}

export async function queryESListings(params: any) {
  const es = getElasticsearchClient();
  const {
    query: rawQuery, location: rawLocation, minPrice, maxPrice, propertyType, bhkType,
    listingPurpose, amenities = [], furnishings = [], bathrooms, minArea, maxArea,
    lat, lng, radiusKm, bounds, polygon, cursor, pageSize = 24, sort = 'relevance', scope = 'both',
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
    aggs: buildAggregations(scope),
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
    propertyTotal,
    projectTotal,
    nextCursor: results.length > 0 ? results[results.length - 1]._sort : null,
    aggregations: esResponse.aggregations || {},
  };
}
