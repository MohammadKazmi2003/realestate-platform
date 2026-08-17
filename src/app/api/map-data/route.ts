import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable, recordEsSuccess } from '@/lib/elasticsearch';
import { queryESListings } from '@/lib/esQueryBuilder';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

// Convert bounds + zoom to a web map tile coordinate for cache key.
// Tile-based keys have bounded cardinality (2^zoom × 2^zoom possible values),
// unlike floating-point bounds which are effectively infinite.
// This dramatically improves cache hit rates for adjacent viewports.
function boundsToTileKey(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, zoom: number): string {
  const centerLon = (bounds.minLng + bounds.maxLng) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const n = Math.pow(2, zoom);
  const x = Math.floor(n * ((centerLon + 180) / 360));
  const latRad = (centerLat * Math.PI) / 180;
  const y = Math.floor(n * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2);
  return `${zoom}/${x}/${y}`;
}

function buildFilterHash(filters: Record<string, any>): string {
  let hash = 0;
  const str = JSON.stringify(filters);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

// Request coalescing: deduplicate identical in-flight requests
const pendingRequests = new Map<string, Promise<any>>();

export async function POST(req: NextRequest) {
  try {
    // Map rate limiter (separate from search + autocomplete)
    const identifier = getRateLimitIdentifier(req);
    const { allowed } = await checkMapRateLimit(identifier);
    if (!allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

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

    // Cache key must include EVERY parameter that can change the map response.
    // Tile-based key: converts continuous viewport coordinates to discrete
    // tile coordinates with bounded cardinality → high hit rate for adjacent viewports.
    const filterHash = buildFilterHash({
      query, location, minPrice, maxPrice, propertyType, bhkType,
      listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
      lat, lng, radiusKm, scope, sort, pageSize, cursor, polygon,
    });
    const cacheKey = `md:${boundsToTileKey({ minLat, maxLat, minLng, maxLng }, zoom)}:${filterHash}`;

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

    // Execute query — single ES call: filters + viewport + total + geotile_grid
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

  const esAvailable = await isEsAvailable();

  // ES is the single source of truth: filters + viewport (BKD geo index)
  // + total count + geotile_grid clusters all come from ONE query, so the
  // list, badge, and map circles describe the exact same filtered population.
  const searchResult = esAvailable
    ? await queryESListings({
        query, location, minPrice, maxPrice, propertyType, bhkType,
        listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
        lat, lng, radiusKm, bounds, polygon, cursor, pageSize, sort, scope,
        zoom,
      }).catch((err) => {
        logger.warn('ES listing query failed', err);
        return null;
      })
    : null;

  // Signal ES success to circuit breaker (if ES query succeeded)
  if (searchResult) recordEsSuccess();

  if (!searchResult) {
    return NextResponse.json({
      error: 'Search services temporarily unavailable',
      clusters: [], clusterTotal: 0,
      results: [], total: 0, totalRelation: undefined,
      nextCursor: null, aggregations: {},
      propertyTotal: 0, projectTotal: 0,
      zoom, precision: undefined,
    }, { status: 503 });
  }

  const clusters = searchResult.clusters || [];
  const clusterTotal = clusters.reduce((sum: number, c: any) => sum + (c.count || 0), 0);

  return {
    // For map markers — lightweight cluster buckets only (no heavy docs)
    clusters,
    clusterTotal,

    // For sidebar — lightweight listing fields
    results: searchResult.results,
    total: searchResult.total,
    totalRelation: searchResult.totalRelation,
    nextCursor: searchResult.nextCursor,

    // For filter badges
    aggregations: searchResult.aggregations,

    // For scope counts
    propertyTotal: searchResult.propertyTotal,
    projectTotal: searchResult.projectTotal,

    // Metadata
    zoom,
    precision: searchResult.precision,
  };
}