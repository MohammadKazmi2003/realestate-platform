import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS, recordEsSuccess, recordEsFailure } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkSearchRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { searchQuerySchema } from '@/lib/validation';
import { logger } from '@/lib/logger';
import { enqueueAnalytics } from '@/lib/events';

function roundBounds(b: any) {
  if (!b) return b;
  return {
    minLat: Math.round(b.minLat * 100) / 100,
    maxLat: Math.round(b.maxLat * 100) / 100,
    minLng: Math.round(b.minLng * 100) / 100,
    maxLng: Math.round(b.maxLng * 100) / 100,
  };
}

export async function POST(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkSearchRateLimit(identifier);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many search requests. Please slow down.' }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = searchQuerySchema.safeParse(body);
    if (!parsed.success) {
      logger.warn('Search API validation failed', parsed.error.issues.map(i => i.message).join(', '));
      return NextResponse.json({ error: 'Invalid search parameters', details: parsed.error.issues }, { status: 400 });
    }

    const sanitize = (s: string | undefined, maxLen = 200) => {
      if (!s) return s;
      if (s.length > maxLen) return s.slice(0, maxLen);
      if (/(.)\1{10,}/.test(s)) return s.slice(0, 50);
      return s;
    };

    const {
      query: rawQuery, location: rawLocation, minPrice, maxPrice, propertyType, bhkType, listingPurpose,
      amenities = [], furnishings = [], bathrooms, minArea, maxArea, lat, lng, radiusKm, bounds,
      polygon, cursor, pageSize = 24, sort = 'relevance', scope = 'properties',
    } = parsed.data;

    const query = sanitize(rawQuery)?.toLowerCase().trim();
    const location = sanitize(rawLocation)?.toLowerCase().trim();
    const normalizedAmenities = amenities.map((a: string) => a.toLowerCase().trim());
    const normalizedFurnishings = furnishings.map((f: string) => f.toLowerCase().trim());

    const cacheKey = `s:${JSON.stringify({ query, location, minPrice, maxPrice, propertyType, bhkType, listingPurpose, amenities: normalizedAmenities, furnishings: normalizedFurnishings, bathrooms, minArea, maxArea, lat, lng, radiusKm, bounds: roundBounds(bounds), pageSize, sort, scope })}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    const esUp = await isEsAvailable();
    if (!esUp) {
      return NextResponse.json({ error: 'ES unavailable', message: 'Search engine temporarily down' }, { status: 503 });
    }

    const es = getElasticsearchClient();
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

    if (bathrooms != null) {
      propertyFilters.push({ range: { bathrooms: { gte: bathrooms } } });
    }

    if (minArea || maxArea) {
      const range: any = {};
      if (minArea) range.gte = minArea;
      if (maxArea) range.lte = maxArea;
      propertyFilters.push({ range: { area_sqft: range } });
    }

    if (lat != null && lng != null) {
      commonFilters.push({
        geo_distance: {
          distance: `${radiusKm || 50}km`,
          location: { lat, lon: lng },
        },
      });
    }

    if (bounds) {
      const { minLat, maxLat, minLng, maxLng } = bounds;
      if (minLat != null && maxLat != null && minLng != null && maxLng != null) {
        commonFilters.push({
          geo_bounding_box: {
            location: {
              top_left: { lat: maxLat, lon: minLng },
              bottom_right: { lat: minLat, lon: maxLng },
            },
          },
        });
      }
    }

    if (polygon && polygon.length >= 3) {
      commonFilters.push({
        geo_polygon: {
          location: {
            points: polygon.map((p: { lat: number; lng: number }) => ({ lat: p.lat, lon: p.lng })),
          },
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

    let sortClause: any[];
    if (scope === 'both') {
      if (sort === 'price_asc') {
        sortClause = [
          { _script: { type: 'number', script: { source: "doc['sort_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
          { sort_price: { order: 'asc' } },
          { _score: { order: 'desc' } },
        ];
      } else if (sort === 'price_desc') {
        sortClause = [
          { _script: { type: 'number', script: { source: "doc['sort_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
          { sort_price: { order: 'desc' } },
          { _score: { order: 'desc' } },
        ];
      } else if (sort === 'newest') {
        sortClause = [{ created_at: { order: 'desc' } }];
      } else if (sort === 'popular') {
        sortClause = [{ _score: { order: 'desc' } }];
      } else {
        sortClause = [{ _score: { order: 'desc' } }];
      }
    } else {
      sortClause = [{ _score: { order: 'desc' } }, { created_at: { order: 'desc' } }];
      if (sort === 'price_asc') {
        sortClause = [
          { _script: { type: 'number', script: { source: "doc['price'].value == 0 ? 1 : 0" }, order: 'asc' } },
          { price: { order: 'asc' } },
          { _score: { order: 'desc' } },
        ];
      }
      if (sort === 'price_desc') {
        sortClause = [
          { _script: { type: 'number', script: { source: "doc['price'].value == 0 ? 1 : 0" }, order: 'asc' } },
          { price: { order: 'desc' } },
          { _score: { order: 'desc' } },
        ];
      }
      if (sort === 'newest') sortClause = [{ created_at: { order: 'desc' } }];
      if (sort === 'popular') sortClause = [{ property_score: { order: 'desc' } }, { _score: { order: 'desc' } }];
    }

    if (lat != null && lng != null) {
      sortClause.unshift({
        _geo_distance: {
          location: { lat, lon: lng },
          order: 'asc',
          unit: 'km',
          distance_type: 'plane',
        },
      });
    }

    const esQuery: any = {
      index: scope === 'both' ? [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS] : ES_INDEX_ALIAS,
      size: pageSize,
      query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
      sort: sortClause,
    };

    if (scope === 'both') {
      esQuery.aggs = {
        by_entity_type: { terms: { field: 'entity_type', size: 2 } },
      };
    } else {
      esQuery.aggs = {
        by_property_type: { terms: { field: 'property_type', size: 20 } },
        by_bhk: { terms: { field: 'bhk_type', size: 10 } },
        by_listing_purpose: { terms: { field: 'listing_purpose', size: 10 } },
        by_furnishing: { terms: { field: 'furnishing_status', size: 10 } },
        by_amenities: { terms: { field: 'amenities', size: 50 } },
        price_stats: { stats: { field: 'price' } },
      };
    }

    if (cursor) {
      esQuery.search_after = cursor;
    }

    const esResponse = await es.search(esQuery);
    recordEsSuccess();
    const hits = esResponse.hits.hits;

    const results = hits.map((hit: any) => ({
      ...hit._source,
      _score: hit._score,
      _sort: hit.sort,
    }));

    const total = typeof esResponse.hits.total === 'object' ? esResponse.hits.total.value : esResponse.hits.total;

    let propertyTotal = 0;
    let projectTotal = 0;
    if (scope === 'both') {
      const entityAgg = (esResponse as any).aggregations?.by_entity_type?.buckets || [];
      for (const bucket of entityAgg) {
        if (bucket.key === 'property') propertyTotal = bucket.doc_count;
        if (bucket.key === 'project') projectTotal = bucket.doc_count;
      }
    }

    const response: any = {
      results,
      total,
      nextCursor: hits.length === pageSize && hits.length > 0 ? hits[hits.length - 1].sort : null,
      aggregations: { facets: (esResponse as any).aggregations || {} },
    };

    if (scope === 'both') {
      response.propertyTotal = propertyTotal;
      response.projectTotal = projectTotal;
    }

    await cacheSet(cacheKey, response, 60);

    logger.searchAnalytics(query || location || '', response.total, 0);

    enqueueAnalytics({
      query_text: query || location || '',
      total_results: response.total,
      latency_ms: 0,
      filters: {
        minPrice, maxPrice, propertyType, bhkType, listingPurpose,
        amenities, furnishings, bathrooms, minArea, maxArea,
        lat, lng, radiusKm,
      },
    }).catch(() => {});

    return NextResponse.json(response);
  } catch (error: any) {
    logger.error('Search API error', error.message);
    recordEsFailure();
    return NextResponse.json({ error: 'Search failed', message: error.message }, { status: 500 });
  }
}
