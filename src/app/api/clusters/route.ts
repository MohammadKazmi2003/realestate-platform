import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS, recordEsSuccess, recordEsFailure } from '@/lib/elasticsearch';
import { isClickHouseAvailable, getMapClusters, type MapTileResponse } from '@/lib/clickhouse';
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
 * B1: Post-filter clusters by exact price range (ClickHouse buckets are coarse).
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

/**
 * Point-in-polygon test using ray casting algorithm.
 * Checks if a point (lat, lng) is inside a polygon defined as [{lat, lng}, ...].
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
 * Filter clusters to only those whose centroid falls inside the polygon.
 */
function filterClustersByPolygon(clusters: any[], polygon: { lat: number; lng: number }[]): any[] {
  if (!polygon || polygon.length < 3) return clusters;
  return clusters.filter(c => {
    const lat = c.center_lat ?? c.lat ?? 0;
    const lng = c.center_lon ?? c.lon ?? 0;
    return pointInPolygon(lat, lng, polygon);
  });
}

function zoomToPrecision(zoom: number): number {
  if (zoom <= 5) return 2;
  if (zoom <= 8) return 3;
  if (zoom <= 11) return 4;
  if (zoom <= 13) return 5;
  return 6;
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
    const { bounds, zoom = 10, filters = {}, scope = 'both', polygon } = body;

    if (!bounds) {
      return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    }

    const { minLat, maxLat, minLng, maxLng } = bounds;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return NextResponse.json({ error: 'Invalid bounds' }, { status: 400 });
    }

    const precision = zoomToPrecision(zoom);

    // B3: Include polygon in cache key — otherwise a cached unfiltered response
    // is served for a polygon-filtered request (and vice-versa)
    const polygonHash = polygon && polygon.length >= 3
      ? JSON.stringify(polygon.map((p: { lat: number; lng: number }) => [Math.round(p.lat * 1000), Math.round(p.lng * 1000)]))
      : 'none';
    const cacheKey = `cl:${JSON.stringify({ bounds: roundBounds(bounds), zoom, precision, scope, filters })}:${polygonHash}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    // Try ClickHouse first (5-20ms for pre-aggregated H3 clusters)
    if (isClickHouseAvailable()) {
      try {
        const hasPropertyFilters = !!(filters.propertyType || filters.bhkType);
        let result: MapTileResponse;

        if (scope === 'both' && hasPropertyFilters) {
          const [propClusters, projClusters] = await Promise.all([
            getMapClusters({ minLat, maxLat, minLng, maxLng }, zoom, {
              minPrice: filters.minPrice ? Number(filters.minPrice) : undefined,
              maxPrice: filters.maxPrice ? Number(filters.maxPrice) : undefined,
              propertyType: filters.propertyType, bhkType: filters.bhkType,
              entityType: 'property',
            }),
            getMapClusters({ minLat, maxLat, minLng, maxLng }, zoom, {
              minPrice: filters.minPrice ? Number(filters.minPrice) : undefined,
              maxPrice: filters.maxPrice ? Number(filters.maxPrice) : undefined,
              entityType: 'project',
            }),
          ]);
          const allClusters = [...propClusters.clusters, ...projClusters.clusters];
          result = {
            clusters: allClusters,
            total: allClusters.reduce((sum, c) => sum + c.count, 0),
            h3_resolution: propClusters.h3_resolution || projClusters.h3_resolution,
          };
        } else {
          result = await getMapClusters(
            { minLat, maxLat, minLng, maxLng },
            zoom,
            {
              minPrice: filters.minPrice ? Number(filters.minPrice) : undefined,
              maxPrice: filters.maxPrice ? Number(filters.maxPrice) : undefined,
              propertyType: filters.propertyType,
              bhkType: filters.bhkType,
              entityType: scope === 'properties' ? 'property' : scope === 'projects' ? 'project' : undefined,
            }
          );
        }

    // B1: Post-filter clusters by exact price range (ClickHouse buckets are coarse)
    result.clusters = filterClustersByPrice(
      result.clusters,
      filters.minPrice ? Number(filters.minPrice) : undefined,
      filters.maxPrice ? Number(filters.maxPrice) : undefined,
    );
    result.total = result.clusters.reduce((sum: number, c: any) => sum + (c.count || 0), 0);

    // Apply polygon filter if provided — filter clusters whose centroids fall inside the polygon
    if (polygon && polygon.length >= 3) {
      result.clusters = filterClustersByPolygon(result.clusters, polygon);
      result.total = result.clusters.reduce((sum: number, c: any) => sum + (c.count || 0), 0);
    }

    await cacheSet(cacheKey, result, 60);
    return NextResponse.json(result);
      } catch (chError) {
        logger.warn('ClickHouse query failed, falling back to Elasticsearch', chError);
      }
    }

    // Fallback to Elasticsearch geohash_grid aggregation
    const esUp = await isEsAvailable();
    if (!esUp) {
      return NextResponse.json({ error: 'Search unavailable' }, { status: 503 });
    }

    const es = getElasticsearchClient();

    const commonFilters: any[] = [
      {
        geo_bounding_box: {
          location: {
            top_left: { lat: maxLat, lon: minLng },
            bottom_right: { lat: minLat, lon: maxLng },
          },
        },
      },
    ];

    if (filters.minPrice || filters.maxPrice) {
      const range: any = {};
      if (filters.minPrice) range.gte = filters.minPrice;
      if (filters.maxPrice) range.lte = filters.maxPrice;
      commonFilters.push({ range: { [scope === 'both' ? 'sort_price' : 'price']: range } });
    }

    if (filters.propertyType) {
      commonFilters.push({ term: { property_type: filters.propertyType } });
    }

    if (filters.bhkType) {
      commonFilters.push({ term: { bhk_type: filters.bhkType } });
    }

    const esQuery: any = {
      index: scope === 'both' ? [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS] : ES_INDEX_ALIAS,
      size: 0,
      query: {
        bool: {
          filter: commonFilters,
        },
      },
      aggs: {
        clusters: {
          geohash_grid: {
            field: 'location',
            precision,
            bounds: {
              top_left: { lat: maxLat, lon: minLng },
              bottom_right: { lat: minLat, lon: maxLng },
            },
          },
          aggs: {
            center: {
              geo_centroid: { field: 'location' },
            },
            avg_price: { avg: { field: 'price' } },
            min_price: { min: { field: 'price' } },
            max_price: { max: { field: 'price' } },
            by_type: {
              terms: { field: 'entity_type', size: 5 },
            },
          },
        },
      },
    };

    const esResponse = await es.search(esQuery);
    recordEsSuccess();

    const buckets = (esResponse.aggregations as any)?.clusters?.buckets || [];

    const clusters = buckets.map((bucket: any) => {
      const center = bucket.center?.location;
      return {
        lat: center?.lat ?? 0,
        lon: center?.lon ?? 0,
        count: bucket.doc_count || 0,
        avg_price: Math.round(bucket.avg_price?.value || 0),
        min_price: Math.round(bucket.min_price?.value || 0),
        max_price: Math.round(bucket.max_price?.value || 0),
        types: bucket.by_type?.buckets?.reduce((acc: any, b: any) => {
          acc[b.key] = b.doc_count;
          return acc;
        }, {}) || {},
      };
    });

    const totalHits = typeof esResponse.hits.total === 'object'
      ? esResponse.hits.total.value
      : esResponse.hits.total || 0;

    const result = {
      clusters,
      total: totalHits,
      precision,
      zoom,
    };

    // B1: Post-filter ES clusters by exact price range
    result.clusters = filterClustersByPrice(
      result.clusters,
      filters.minPrice ? Number(filters.minPrice) : undefined,
      filters.maxPrice ? Number(filters.maxPrice) : undefined,
    );
    result.total = result.clusters.reduce((sum: number, c: any) => sum + (c.count || 0), 0);

    // Apply polygon filter to ES clusters (same as ClickHouse path).
    // Without this, clusters outside the selected boundary appear on the map.
    if (polygon && polygon.length >= 3) {
      result.clusters = filterClustersByPolygon(result.clusters, polygon);
      result.total = result.clusters.reduce((sum: number, c: any) => sum + (c.count || 0), 0);
    }

    await cacheSet(cacheKey, result, 30);

    return NextResponse.json(result);

  } catch (error: any) {
    logger.error('Clusters API error', error);
    recordEsFailure();
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
