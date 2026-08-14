import { NextRequest, NextResponse } from 'next/server';
import { isClickHouseAvailable, getMapClusters } from '@/lib/clickhouse';
import { isEsAvailable, recordEsSuccess } from '@/lib/elasticsearch';
import { queryESListings } from '@/lib/esQueryBuilder';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

function roundBounds(b: any) {
  if (!b) return b;
  return {
    minLat: Math.round(b.minLat * 100) / 100,
    maxLat: Math.round(b.maxLat * 100) / 100,
    minLng: Math.round(b.minLng * 100) / 100,
    maxLng: Math.round(b.maxLng * 100) / 100,
  };
}

/**
 * Point-in-polygon test using ray casting.
 */
function pointInPolygon(lat: number, lng: number, polygon: { lat: number; lng: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Filter cluster centroids by polygon. Only clusters whose centroid falls inside the polygon are kept.
 */
function filterClustersByPolygon(clusters: any[], polygon: { lat: number; lng: number }[]): any[] {
  if (!polygon || polygon.length < 3) return clusters;
  return clusters.filter(c => {
    const lat = c.center_lat ?? c.lat ?? 0;
    const lng = c.center_lon ?? c.lon ?? 0;
    return pointInPolygon(lat, lng, polygon);
  });
}

/**
 * B1: Post-filter clusters by exact price range.
 * ClickHouse price_bucket is coarse (₹1L buckets) — a cluster whose max_price
 * is above maxPrice (or min_price below minPrice) would otherwise over-count.
 */
function filterClustersByPrice(
  clusters: any[],
  minPrice?: number,
  maxPrice?: number,
): any[] {
  if (minPrice == null && maxPrice == null) return clusters;
  return clusters.filter(c => {
    if (minPrice != null && (c.max_price ?? Infinity) < minPrice) return false;
    if (maxPrice != null && (c.min_price ?? 0) > maxPrice) return false;
    return true;
  });
}

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

    // Tile-based cache key: converts continuous viewport coordinates to discrete
    // tile coordinates with bounded cardinality. This gives 80%+ cache hit rate
    // for adjacent viewports vs near-0% with floating-point bounds.
    const filterHash = buildFilterHash({
      query, location, minPrice, maxPrice, propertyType, bhkType,
      listingPurpose, scope, sort, pageSize, polygon,
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

  // Build cluster query: when scope='both' with property-specific filters (BHK/propertyType),
  // query ClickHouse per-entity-type and merge — otherwise a single query suffices
  const hasPropertyFilters = !!(propertyType || bhkType);
  const locationText = location || query || undefined;  // B2: forward text to CH
  const clusterPromise = chAvailable
    ? (async () => {
        if (scope === 'both' && hasPropertyFilters) {
          // Two queries: properties (with filters) + projects (without property-specific filters)
          const [propClusters, projClusters] = await Promise.all([
            getMapClusters(bounds, zoom, {
              minPrice: minPrice ? Number(minPrice) : undefined,
              maxPrice: maxPrice ? Number(maxPrice) : undefined,
              propertyType, bhkType,
              entityType: 'property',
              locationText,
            }).catch(() => null),
            getMapClusters(bounds, zoom, {
              minPrice: minPrice ? Number(minPrice) : undefined,
              maxPrice: maxPrice ? Number(maxPrice) : undefined,
              entityType: 'project',
              locationText,
            }).catch(() => null),
          ]);
          // Merge clusters from both entity types
          const allClusters = [
            ...(propClusters?.clusters || []),
            ...(projClusters?.clusters || []),
          ];
          return {
            clusters: allClusters,
            total: allClusters.reduce((sum, c) => sum + c.count, 0),
            h3_resolution: propClusters?.h3_resolution || projClusters?.h3_resolution || 8,
          };
        }
        return getMapClusters(bounds, zoom, {
          minPrice: minPrice ? Number(minPrice) : undefined,
          maxPrice: maxPrice ? Number(maxPrice) : undefined,
          propertyType, bhkType,
          entityType: scope === 'properties' ? 'property'
                    : scope === 'projects' ? 'project' : undefined,
          locationText,
        });
      })().catch((err) => {
        logger.warn('ClickHouse cluster query failed', err);
        return null;
      })
    : Promise.resolve(null);

  // Parallel queries: ClickHouse clusters + ES listings
  const [clusterResult, searchResult] = await Promise.all([
    clusterPromise,

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

  // Signal ES success to circuit breaker (if ES query succeeded)
  if (searchResult) recordEsSuccess();

  // If both backends failed, return error state (not silent empty results)
  if (!clusterResult && !searchResult) {
    return NextResponse.json({
      error: 'Search services temporarily unavailable',
      clusters: [], clusterTotal: 0,
      results: [], total: 0,
      nextCursor: null, aggregations: {},
      propertyTotal: 0, projectTotal: 0,
      zoom, precision: undefined,
    }, { status: 503 });
  }

  // Combine into single response
  let clusters = clusterResult?.clusters || [];

  // B1: Post-filter clusters by exact price range (ClickHouse buckets are coarse)
  const minP = minPrice ? Number(minPrice) : undefined;
  const maxP = maxPrice ? Number(maxPrice) : undefined;
  clusters = filterClustersByPrice(clusters, minP, maxP);

  // Apply polygon filter to clusters when boundary is active.
  // ClickHouse clusters are NOT filtered by polygon — they use bbox only.
  // ES listings ARE filtered by polygon (geo_polygon in queryESListings).
  // This post-filter ensures cluster counts only include listings inside the boundary.
  if (polygon && polygon.length >= 3) {
    clusters = filterClustersByPolygon(clusters, polygon);
  }

  return {
    // For map markers
    clusters,
    clusterTotal: clusters.reduce((sum: number, c: any) => sum + (c.count || 0), 0),

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
