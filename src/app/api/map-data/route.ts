import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable, recordEsSuccess } from '@/lib/elasticsearch';
import { queryESListings, queryESMapMarkers } from '@/lib/esQueryBuilder';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { prepareMapQuery } from '@/lib/filterNormalize';

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' };

// Request coalescing: deduplicate identical in-flight ES queries. Keyed by
// cache-entry key (markers and list coalesce independently).
const pendingRequests = new Map<string, Promise<any>>();

async function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = pendingRequests.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => {
    if (pendingRequests.get(key) === promise) pendingRequests.delete(key);
  });
  pendingRequests.set(key, promise);
  return promise;
}

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
      bounds: rawBounds, zoom = 10, scope = 'both',
      sort = 'newest', pageSize = 24, cursor,
      query, location, minPrice, maxPrice, propertyType, bhkType,
      minBedrooms, maxBedrooms,
      listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
      lat, lng, radiusKm, polygon,
    } = body;

    if (!rawBounds) {
      return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    }

    const { minLat, maxLat, minLng, maxLng } = rawBounds;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return NextResponse.json({ error: 'Invalid bounds' }, { status: 400 });
    }

    // Normalize once: snapped filters + dust-trimmed EXACT bounds feed BOTH
    // the ES queries and the cache keys, so list, badge, and map dots always
    // describe the exact same filtered population for the exact viewport.
    // Markers (md:v4:m) strip sort/pagination; the list (md:v4:l) keeps them.
    const { bounds, filters, markerKey, listKey } = prepareMapQuery(
      { minLat, maxLat, minLng, maxLng },
      {
        query, location, minPrice, maxPrice, propertyType, bhkType,
        minBedrooms, maxBedrooms,
        listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
        lat, lng, radiusKm, scope, sort, pageSize, cursor, polygon,
      }
    );

    // Marker sampling seed identifies the exact normalized viewport+filters.
    const esParams = { ...filters, bounds, seedKey: markerKey };

    // Serve fully-cached responses without touching ES at all (including
    // when ES is down — cache is the resilience layer).
    const [cachedList, cachedMarkers] = await Promise.all([
      cacheGet<any>(listKey),
      cacheGet<any>(markerKey),
    ]);
    if (cachedList && cachedMarkers) {
      return NextResponse.json(
        {
          markers: cachedMarkers,
          results: cachedList.results,
          total: cachedList.total,
          totalRelation: cachedList.totalRelation,
          nextCursor: cachedList.nextCursor,
          propertyTotal: cachedList.propertyTotal,
          projectTotal: cachedList.projectTotal,
          projectGroups: cachedList.projectGroups || [],
          zoom,
        },
        { headers: CACHE_HEADERS }
      );
    }

    const esAvailable = await isEsAvailable();
    if (!esAvailable) {
      return NextResponse.json(
        {
          error: 'Search services temporarily unavailable',
          results: [], markers: [], total: 0, totalRelation: undefined,
          nextCursor: null, propertyTotal: 0, projectTotal: 0,
          projectGroups: [], zoom,
        },
        { status: 503 }
      );
    }

    const [searchResult, markers] = await Promise.all([
      singleflight(listKey, async () => {
        const cached = await cacheGet<any>(listKey);
        if (cached) return cached;
        const result = await queryESListings({ ...esParams, cursor, pageSize }).catch((err) => {
          logger.warn('ES listing query failed', err);
          return null;
        });
        // NEVER cache error responses.
        if (result) await cacheSet(listKey, result, 60);
        return result;
      }),
      singleflight(markerKey, async () => {
        const cached = await cacheGet<any>(markerKey);
        if (cached) return cached;
        const result = await queryESMapMarkers(esParams).catch((err) => {
          logger.warn('ES map marker query failed', err);
          return null;
        });
        if (result) await cacheSet(markerKey, result, 60);
        return result;
      }),
    ]);

    // Signal ES success to circuit breaker (if ES query succeeded)
    if (searchResult && markers) recordEsSuccess();

    if (!searchResult || !markers) {
      return NextResponse.json(
        {
          error: 'Search services temporarily unavailable',
          results: [], markers: [], total: 0, totalRelation: undefined,
          nextCursor: null, propertyTotal: 0, projectTotal: 0,
          projectGroups: [], zoom,
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
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
        // Community rollup for "N New Homes" pills
        projectGroups: searchResult.projectGroups || [],

        // Metadata
        zoom,
      },
      { headers: CACHE_HEADERS }
    );
  } catch (error: any) {
    logger.error('Map data API error', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
