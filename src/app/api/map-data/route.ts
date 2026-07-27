import { NextRequest, NextResponse } from 'next/server';
import { isClickHouseAvailable, getMapClusters } from '@/lib/clickhouse';
import { isEsAvailable } from '@/lib/elasticsearch';
import { queryESListings } from '@/lib/esQueryBuilder';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';

function roundBounds(b: any) {
  if (!b) return b;
  return {
    minLat: Math.round(b.minLat * 100) / 100,
    maxLat: Math.round(b.maxLat * 100) / 100,
    minLng: Math.round(b.minLng * 100) / 100,
    maxLng: Math.round(b.maxLng * 100) / 100,
  };
}

// Request coalescing: deduplicate identical in-flight requests
const pendingRequests = new Map<string, Promise<any>>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      bounds, zoom = 10, filters = {}, scope = 'both',
      sort = 'relevance', pageSize = 24, cursor,
      query, location, minPrice, maxPrice, propertyType, bhkType,
      listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
      lat, lng, radiusKm, polygon,
    } = body;

    if (!bounds) {
      return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    }

    const { minLat, maxLat, minLng, maxLng } = bounds;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return NextResponse.json({ error: 'Invalid bounds' }, { status: 400 });
    }

    // Unified cache key (includes ALL parameters)
    const cacheKey = `md:${JSON.stringify({
      bounds: roundBounds(bounds), zoom, query, location,
      minPrice, maxPrice, propertyType, bhkType,
      listingPurpose, scope, sort, pageSize, cursor,
    })}`;

    // Check cache first
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }

    // Request coalescing: if identical request is in-flight, wait for it
    if (pendingRequests.has(cacheKey)) {
      const result = await pendingRequests.get(cacheKey);
      return NextResponse.json(result);
    }

    // Execute query (parallel: ClickHouse + ES)
    const promise = executeMapQuery(body);
    pendingRequests.set(cacheKey, promise);

    try {
      const result = await promise;

      // Cache unified response (60s TTL)
      await cacheSet(cacheKey, result, 60);

      return NextResponse.json(result, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    } finally {
      pendingRequests.delete(cacheKey);
    }

  } catch (error: any) {
    logger.error('Map data API error', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function executeMapQuery(body: any) {
  const {
    bounds, zoom = 10, filters = {}, scope = 'both',
    sort = 'relevance', pageSize = 24, cursor,
    query, location, minPrice, maxPrice, propertyType, bhkType,
    listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
    lat, lng, radiusKm, polygon,
  } = body;

  // Check availability before parallel queries
  const chAvailable = isClickHouseAvailable();
  const esAvailable = await isEsAvailable();

  // Parallel queries: ClickHouse clusters + ES listings
  const [clusterResult, searchResult] = await Promise.all([
    // ClickHouse: fast H3 clusters (5-20ms)
    chAvailable
      ? getMapClusters(
          bounds, zoom,
          {
            minPrice: minPrice ? Number(minPrice) : undefined,
            maxPrice: maxPrice ? Number(maxPrice) : undefined,
            propertyType, bhkType,
            entityType: scope === 'properties' ? 'property'
                      : scope === 'projects' ? 'project' : undefined,
          }
        ).catch((err) => {
          logger.warn('ClickHouse cluster query failed', err);
          return null;
        })
      : Promise.resolve(null),

    // ES: listings + aggregations (50-200ms)
    esAvailable
      ? queryESListings({
          query, location, minPrice, maxPrice, propertyType, bhkType,
          listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
          lat, lng, radiusKm, bounds, polygon, cursor, pageSize, sort, scope,
        }).catch((err) => {
          logger.warn('ES listing query failed', err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  // Combine into single response
  return {
    // For map markers
    clusters: clusterResult?.clusters || [],
    clusterTotal: clusterResult?.total || 0,

    // For sidebar
    results: searchResult?.results || [],
    total: searchResult?.total || 0,
    nextCursor: searchResult?.nextCursor || null,

    // For filter badges
    aggregations: searchResult?.aggregations || {},

    // For scope counts
    propertyTotal: searchResult?.propertyTotal || 0,
    projectTotal: searchResult?.projectTotal || 0,

    // Metadata
    zoom,
    precision: clusterResult?.h3_resolution,
  };
}
