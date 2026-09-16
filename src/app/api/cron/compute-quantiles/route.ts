import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { getOrComputeQuantileThresholds } from '@/lib/quantiles';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// OPTIONAL prewarm for runtime quantiles (infra-free design does not require
// it — first user request per region×field computes via singleflight instead).
// Warms v2 keys (q:v2:{region}:{field}:{intent}) so morning traffic skips the
// one cold compute. Safe to never schedule; safe to run manually.
// Auth: if CRON_SECRET set, require Bearer; else allow (dev/staging trigger).
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get('authorization') || '';
      if (auth !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    const es: any = getElasticsearchClient();
    // Seed regions: India metros + UAE + coarse grid.
    const seedBounds = [
      { minLat: 28, maxLat: 29, minLng: 77, maxLng: 78 }, // Delhi
      { minLat: 19, maxLat: 20, minLng: 72, maxLng: 73 }, // Mumbai
      { minLat: 12, maxLat: 13, minLng: 77, maxLng: 78 }, // Bengaluru
      { minLat: 25, maxLat: 26, minLng: 55, maxLng: 56 }, // Dubai
    ];
    const sorts = ['price_desc', 'price_asc', 'newest'];
    const scopes = ['both', 'properties'];
    let done = 0;
    let total = 0;
    const errors: string[] = [];
    for (const bounds of seedBounds) {
      for (const scope of scopes) {
        const index =
          scope === 'projects' ? PROJECTS_INDEX_ALIAS : scope === 'properties' ? ES_INDEX_ALIAS : [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS];
        for (const sort of sorts) {
          total++;
          try {
            const q = await getOrComputeQuantileThresholds(bounds, sort, scope, {
              baseMust: [],
              baseFilters: [{ term: { status: 'available' } }],
              index,
              timeoutMs: 5000,
              runAgg: async (o) => {
                const res: any = await es.search({
                  index: o.index,
                  size: 0,
                  track_total_hits: false,
                  query: {
                    bool: {
                      filter: [
                        ...o.filters,
                        {
                          geo_bounding_box: {
                            location: {
                              top_left: { lat: o.regionBounds.maxLat, lon: o.regionBounds.minLng },
                              bottom_right: { lat: o.regionBounds.minLat, lon: o.regionBounds.maxLng },
                            },
                          },
                        },
                      ],
                    },
                  },
                  aggs: { p: { percentiles: { field: (await import('@/lib/quantiles')).sortFieldForQuantile(sort, scope)?.field || 'sort_price', percents: [50, 90] } } },
                  request_cache: true,
                  timeout: '5000ms',
                  allow_partial_search_results: true,
                });
                const vals = res?.aggregations?.p?.values || {};
                const p50 = Number(vals['50.0']);
                const p90 = Number(vals['90.0']);
                return { ...(Number.isFinite(p50) ? { p50 } : {}), ...(Number.isFinite(p90) ? { p90 } : {}) };
              },
            });
            if (q) done++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn('quantile prewarm failed', { sort, scope, err: msg.slice(0, 200) });
            errors.push(`${sort}/${scope}: ${msg.slice(0, 120)}`);
          }
        }
      }
    }
    logger.info('quantiles prewarmed', { done, total });
    return NextResponse.json({ ok: true, done, total, errors: errors.slice(0, 4) });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('quantile cron error', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
