import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable, recordEsSuccess } from '@/lib/elasticsearch';
import { queryESListings, queryESMapMarkers } from '@/lib/esQueryBuilder';
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
      bounds, zoom = 10, scope = 'both',
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
    const cacheKey = `md:v2:${boundsToTileKey({ minLat, maxLat, minLng, maxLng }, zoom)}:${filterHash}`;

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

    // Execute query — two parallel ES calls sharing the same filters: the 24-doc
    // sidebar list (with totals agg) + up to 500 slim map markers.
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
    bounds, zoom = 10, scope = 'both',
    sort = 'relevance', pageSize = 24, cursor,
    query, location, minPrice, maxPrice, propertyType, bhkType,
    listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
    lat, lng, radiusKm, polygon,
  } = body;

  const esAvailable = await isEsAvailable();

  const esParams = {
    query, location, minPrice, maxPrice, propertyType, bhkType,
    listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
    lat, lng, radiusKm, bounds, polygon, sort, scope,
  };

  // ES is the single source of truth: the sidebar list (queryESListings) and
  // the map dots (queryESMapMarkers) run against the SAME filters, so the
  // list, badge, and map markers describe the exact same filtered population.
  // Two lightweight queries in parallel: 24 full docs for the list + up to 500
  // slim markers for the map dots.
  const [searchResult, markers] = esAvailable
    ? await Promise.all([
        queryESListings({ ...esParams, cursor, pageSize })
          .catch((err) => {
            logger.warn('ES listing query failed', err);
            return null;
          }),
        queryESMapMarkers(esParams)
          .catch((err) => {
            logger.warn('ES map marker query failed', err);
            return [];
          }),
      ])
    : [null, []];

  // Signal ES success to circuit breaker (if ES query succeeded)
  if (searchResult) recordEsSuccess();

  if (!searchResult) {
    return NextResponse.json({
      error: 'Search services temporarily unavailable',
      results: [], markers: [], total: 0, totalRelation: undefined,
      nextCursor: null,
      propertyTotal: 0, projectTotal: 0,
      zoom,
    }, { status: 503 });
  }

  return {
    // For map dots — up to 500 lightweight markers (id, lat, lon, price)
    markers,

    // For sidebar — lightweight listing fields
    results: searchResult.results,
    total: searchResult.total,
    totalRelation: searchResult.totalRelation,
    nextCursor: searchResult.nextCursor,

    // For scope counts
    propertyTotal: searchResult.propertyTotal,
    projectTotal: searchResult.projectTotal,

    // Metadata
    zoom,
  };
}