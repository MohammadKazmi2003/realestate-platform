import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, PROJECTS_INDEX_ALIAS, recordEsSuccess, recordEsFailure } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkSearchRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkSearchRateLimit(identifier);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many search requests. Please slow down.' }, { status: 429 });
  }

  try {
    const body = await req.json();
    const {
      query,
      minPrice, maxPrice,
      constructionPhases,
      amenity,
      amenities,
      sort = 'relevance',
      pageSize = 24,
      cursor,
      page,
      bounds,
      polygon,
    } = body;

    const sanitize = (s: string | undefined, maxLen = 200) => {
      if (!s) return s;
      if (s.length > maxLen) return s.slice(0, maxLen);
      if (/(.)\1{10,}/.test(s)) return s.slice(0, 50);
      return s;
    };

    const cleanedQuery = sanitize(query)?.toLowerCase().trim();

    const roundBounds = (b: any) => {
      if (!b) return b;
      return {
        minLat: Math.round(b.minLat * 100) / 100,
        maxLat: Math.round(b.maxLat * 100) / 100,
        minLng: Math.round(b.minLng * 100) / 100,
        maxLng: Math.round(b.maxLng * 100) / 100,
      };
    };
    const normalizedAmenities = (amenities || []).map((a: string) => a.toLowerCase().trim());
    const normalizedConstructionPhases = (constructionPhases || []).map((c: string) => c.toLowerCase().trim());
    const cacheKey = `ps:${JSON.stringify({ cleanedQuery, minPrice, maxPrice, constructionPhases: normalizedConstructionPhases, amenity: amenity?.toLowerCase().trim(), amenities: normalizedAmenities, sort, pageSize, cursor, page, bounds: roundBounds(bounds) })}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    const esUp = await isEsAvailable();
    if (!esUp) {
      return NextResponse.json({ error: 'ES unavailable' }, { status: 503 });
    }

    const es = getElasticsearchClient();
    const must: any[] = [];
    const filters: any[] = [];

    if (cleanedQuery) {
      must.push({
        multi_match: {
          query: cleanedQuery,
          fields: ['name^3', 'description^2', 'developer_name^2', 'location_text^2', 'amenities'],
          type: 'best_fields',
          fuzziness: 'AUTO',
          operator: 'or',
        },
      });
    }

    if (minPrice || maxPrice) {
      const range: any = {};
      if (minPrice) range.gte = minPrice;
      if (maxPrice) range.lte = maxPrice;
      filters.push({ range: { low_price: range } });
    }

    const phases = constructionPhases || [];
    if (phases.length > 0) {
      filters.push({ terms: { construction_phase: phases } });
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

    if (polygon && polygon.length >= 3) {
      filters.push({
        geo_polygon: {
          location: {
            points: polygon.map((p: { lat: number; lng: number }) => ({ lat: p.lat, lon: p.lng })),
          },
        },
      });
    }

    const amenityNames = amenities || [];
    if (amenity) amenityNames.push(amenity);
    if (amenityNames.length > 0) {
      filters.push({ terms: { amenities: amenityNames } });
    }

    let sortClause: any[] = [{ _score: { order: 'desc' } }, { created_at: { order: 'desc' } }, { id: { order: 'desc' } }];
    if (sort === 'price_asc') {
      sortClause = [
        { _script: { type: 'number', script: { source: "doc['low_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
        { low_price: { order: 'asc' } },
        { _score: { order: 'desc' } },
        { id: { order: 'desc' } },
      ];
    }
    if (sort === 'price_desc') {
      sortClause = [
        { _script: { type: 'number', script: { source: "doc['low_price'].value == 0 ? 1 : 0" }, order: 'asc' } },
        { low_price: { order: 'desc' } },
        { _score: { order: 'desc' } },
        { id: { order: 'desc' } },
      ];
    }
    if (sort === 'date_asc') sortClause = [{ delivery_date: { order: 'asc' } }, { _score: { order: 'desc' } }, { id: { order: 'desc' } }];
    if (sort === 'date_desc') sortClause = [{ delivery_date: { order: 'desc' } }, { _score: { order: 'desc' } }, { id: { order: 'desc' } }];

    const size = pageSize || 12;

    const esQuery: any = {
      index: PROJECTS_INDEX_ALIAS,
      size,
      query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
      sort: sortClause,
      _source: ['id', 'name', 'slug', 'low_price', 'high_price', 'construction_phase', 'delivery_date', 'developer_name', 'image_url', 'location_text', 'location', 'amenities', 'description', 'created_at'],
    };

    if (cursor) {
      esQuery.search_after = cursor;
    }

    const esResponse = await es.search(esQuery);
    recordEsSuccess();
    const hits = esResponse.hits.hits;

    const results = hits.map((hit: any) => {
      const loc = hit._source.location || {};
      return {
        id: hit._source.id,
        name: hit._source.name,
        slug: hit._source.slug,
        low_price: hit._source.low_price || 0,
        high_price: hit._source.high_price || 0,
        construction_phase: hit._source.construction_phase || '',
        delivery_date: hit._source.delivery_date || null,
        developer_name: hit._source.developer_name || '',
        primary_image: hit._source.image_url || null,
        location_name: hit._source.location_text || null,
        latitude: loc.lat ?? null,
        longitude: loc.lon ?? null,
        _score: hit._score,
        _sort: hit.sort,
      };
    });

    const response = {
      results,
      total: typeof esResponse.hits.total === 'object' ? esResponse.hits.total.value : esResponse.hits.total,
      nextCursor: hits.length === size && hits.length > 0 ? hits[hits.length - 1].sort : null,
    };

    await cacheSet(cacheKey, response, 60);

    return NextResponse.json(response);
  } catch (error: any) {
    logger.error('Projects search API error', error.message);
    recordEsFailure();
    return NextResponse.json({ error: 'Search failed', message: error.message }, { status: 500 });
  }
}
