import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS, recordEsSuccess, recordEsFailure } from '@/lib/elasticsearch';
import { isClickHouseAvailable, getMapClusters, type MapTileResponse } from '@/lib/clickhouse';
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

function zoomToPrecision(zoom: number): number {
  if (zoom <= 5) return 2;
  if (zoom <= 8) return 3;
  if (zoom <= 11) return 4;
  if (zoom <= 13) return 5;
  return 6;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { bounds, zoom = 10, filters = {}, scope = 'both' } = body;

    if (!bounds) {
      return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    }

    const { minLat, maxLat, minLng, maxLng } = bounds;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return NextResponse.json({ error: 'Invalid bounds' }, { status: 400 });
    }

    const precision = zoomToPrecision(zoom);

    const cacheKey = `cl:${JSON.stringify({ bounds: roundBounds(bounds), zoom, precision, scope, filters })}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached);
    }

    // Try ClickHouse first (5-20ms for pre-aggregated H3 clusters)
    if (isClickHouseAvailable()) {
      try {
        const result = await getMapClusters(
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
      commonFilters.push({ range: { price: range } });
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

    await cacheSet(cacheKey, result, 30);

    return NextResponse.json(result);

  } catch (error: any) {
    logger.error('Clusters API error', error);
    recordEsFailure();
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
