import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, ES_INDEX_ALIAS } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkSearchRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { searchQuerySchema } from '@/lib/validation';
import { logger } from '@/lib/logger';

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

    const {
      query, location, minPrice, maxPrice, propertyType, bhkType, listingPurpose,
      amenities = [], furnishings = [], lat, lng, radiusKm, bounds,
      cursor, pageSize = 24, sort = 'relevance',
    } = parsed.data;

    const cacheKey = `search:${JSON.stringify({ query, location, minPrice, maxPrice, propertyType, bhkType, listingPurpose, lat, lng, radiusKm, bounds, cursor, pageSize, sort })}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    const es = getElasticsearchClient();
    const must: any[] = [];
    const filters: any[] = [];

    if (query) {
      must.push({
        multi_match: {
          query,
          fields: ['title^3', 'description^2', 'location_text^2', 'project_name^2', 'developer_name'],
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
          fields: ['location_text^3', 'title^2', 'project_name^1'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      });
    }

    filters.push({ term: { status: 'available' } });

    if (minPrice || maxPrice) {
      const range: any = {};
      if (minPrice) range.gte = minPrice;
      if (maxPrice) range.lte = maxPrice;
      filters.push({ range: { price: range } });
    }

    if (propertyType) filters.push({ term: { property_type: propertyType } });
    if (bhkType) filters.push({ term: { bhk_type: bhkType } });
    if (listingPurpose) filters.push({ term: { listing_purpose: listingPurpose } });
    if (amenities.length > 0) filters.push({ terms: { amenities } });
    if (furnishings.length > 0) filters.push({ terms: { furnishings } });

    let sortClause: any[] = [{ _score: { order: 'desc' } }, { created_at: { order: 'desc' } }];

    if (lat != null && lng != null) {
      filters.push({
        geo_distance: {
          distance: `${radiusKm || 50}km`,
          location: { lat, lon: lng },
        },
      });
      sortClause = [
        {
          _geo_distance: {
            location: { lat, lon: lng },
            order: 'asc',
            unit: 'km',
            distance_type: 'plane',
          },
        },
        ...sortClause,
      ];
    }

    if (bounds) {
      const { minLat, maxLat, minLng, maxLng } = bounds;
      if (minLat != null && maxLat != null && minLng != null && maxLng != null) {
        filters.push({
          geo_bounding_box: {
            location: {
              top_left: { lat: maxLat, lon: minLng },
              bottom_right: { lat: minLat, lon: maxLng },
            },
          },
        });
      }
    }

    if (sort === 'price_asc') sortClause = [{ price: { order: 'asc' } }];
    if (sort === 'price_desc') sortClause = [{ price: { order: 'desc' } }];
    if (sort === 'newest') sortClause = [{ created_at: { order: 'desc' } }];

    const esQuery: any = {
      index: ES_INDEX_ALIAS,
      size: pageSize,
      query: {
        bool: {
          must: must.length > 0 ? must : [{ match_all: {} }],
          filter: filters,
        },
      },
      sort: sortClause,
    };

    if (cursor) {
      esQuery.search_after = cursor;
    }

    const esResponse = await es.search(esQuery);
    const hits = esResponse.hits.hits;

    const results = hits.map((hit: any) => ({
      ...hit._source,
      _score: hit._score,
      _sort: hit.sort,
    }));

    const aggregations: any = {};
    try {
      const aggResponse = await es.search({
        index: ES_INDEX_ALIAS,
        size: 0,
        query: { bool: { must, filter: filters } },
        aggs: {
          by_property_type: { terms: { field: 'property_type', size: 20 } },
          by_bhk: { terms: { field: 'bhk_type', size: 10 } },
          by_listing_purpose: { terms: { field: 'listing_purpose', size: 10 } },
          by_furnishing: { terms: { field: 'furnishing_status', size: 10 } },
          by_amenities: { terms: { field: 'amenities', size: 50 } },
          price_stats: { stats: { field: 'price' } },
        },
      });
      aggregations.facets = aggResponse.aggregations;
    } catch {
      aggregations.facets = {};
    }

    const response = {
      results,
      total: typeof esResponse.hits.total === 'object' ? esResponse.hits.total.value : esResponse.hits.total,
      nextCursor: hits.length === pageSize && hits.length > 0 ? hits[hits.length - 1].sort : null,
      aggregations,
    };

    await cacheSet(cacheKey, response, 60);

    logger.searchAnalytics(query || location || '', response.total, 0);

    return NextResponse.json(response);
  } catch (error: any) {
    logger.error('Search API error', error.message);
    return NextResponse.json({ error: 'Search failed', message: error.message }, { status: 500 });
  }
}
