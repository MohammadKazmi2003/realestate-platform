import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable } from '@/lib/elasticsearch';
import { cacheGet, cacheSet, singleflightCompute } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { prepareTileQuery, normalizeFilters } from '@/lib/filterNormalize';
import { viewportCoveringTiles, tileToBounds, redisTTLForSort, cdnSMaxAgeForSort } from '@/lib/mapTiles';
import { buildFiltersForTiles } from '@/lib/esTileFilters';
import { queryTileMarkersForBounds } from '@/lib/esTileMarkers';
import { mergeTileMarkers } from '@/lib/tileMerge';
import { flags } from '@/lib/flags';

// Scale-ready: bounded tile concurrency so one pan can't open 12-24 ES
// sockets at once. Adding Next/ES nodes then scales QPS instead of
// amplifying per-request sockets. Env TILE_CONCURRENCY, default 6.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Additive P4 route: quantized tile MAP (size:0 grid), never exact-viewport.
// Client fetches ALL covering tiles and merges/clips — never single center tile.
export async function POST(req: NextRequest) {
  try {
    const identifier = getRateLimitIdentifier(req);
    const { allowed } = await checkMapRateLimit(identifier);
    if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

    const body = await req.json();
    const { bounds: rawBounds, zoom = 10, scope = 'both', sort = 'newest', ...rest } = body;
    if (!rawBounds) return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    const { minLat, maxLat, minLng, maxLng } = rawBounds;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return NextResponse.json({ error: 'Invalid bounds' }, { status: 400 });
    }
    // Clamp via shared normalizer (widen-only).
    const norm = normalizeFilters({ scope, sort, ...rest } as any);
    void norm;
    const tiles = viewportCoveringTiles(
      {
        minLat: Math.max(-85.0511, Math.min(85.0511, minLat)),
        maxLat: Math.max(-85.0511, Math.min(85.0511, maxLat)),
        minLng: Math.max(-180, Math.min(180, minLng)),
        maxLng: Math.max(-180, Math.min(180, maxLng)),
      },
      Number(zoom) || 10
    );
    const sortStr = String(sort || 'newest');
    const sMax = cdnSMaxAgeForSort(sortStr);
    const ttl = redisTTLForSort(sortStr);

    // Runtime quantiles for sort-aware tile narrowing (fallback = no-range).
    // Zoom gate mirrors map-data: overview zooms concentrate, street zooms
    // show the full set. popular has no deterministic field -> newest reps.
    let quantileRange: any | null = null;
    if (flags.quantileFilter && sortStr !== 'popular' && Number(zoom) < 10) {
      try {
        const { getOrComputeQuantileThresholds, quantileRangeForSort: qRange, sortFieldForQuantile: qField } = await import('@/lib/quantiles');
        const { getElasticsearchClient: getEs, ES_INDEX_ALIAS: esA, PROJECTS_INDEX_ALIAS: esP } = await import('@/lib/elasticsearch');
        const qf = qField(sortStr, String(scope));
        if (qf) {
          const qIndex = String(scope) === 'projects' ? esP : String(scope) === 'properties' ? esA : [esA, esP];
          const restPurpose = (rest as any)?.listingPurpose;
          const qBase: any[] = [{ term: { status: 'available' } }];
          if (typeof restPurpose === 'string' && /rent|lease|\bpg\b/i.test(restPurpose)) {
            qBase.push({ bool: { must_not: { term: { entity_type: 'project' } } } });
          }
          const q = await getOrComputeQuantileThresholds({ minLat, maxLat, minLng, maxLng }, sortStr, String(scope), {
            listingPurpose: typeof restPurpose === 'string' ? restPurpose : undefined,
            baseMust: [],
            baseFilters: qBase,
            index: qIndex,
            timeoutMs: 2000,
            runAgg: async (o: any) => {
              const es: any = getEs();
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
                aggs: { p: { percentiles: { field: qf.field, percents: [50, 90] } } },
                request_cache: true,
                timeout: '2000ms',
                allow_partial_search_results: true,
              });
              const vals = res?.aggregations?.p?.values || {};
              const p50 = Number(vals['50.0']);
              const p90 = Number(vals['90.0']);
              return { ...(Number.isFinite(p50) ? { p50 } : {}), ...(Number.isFinite(p90) ? { p90 } : {}) };
            },
          });
          quantileRange = qRange(q, sortStr, String(scope));
        }
      } catch { quantileRange = null; }
    }

    const esAvailable = await isEsAvailable();
    if (!esAvailable) {
      return NextResponse.json({ error: 'Search services temporarily unavailable', markers: [], cells: [], zoom }, { status: 503 });
    }

    const t0 = Date.now();
    const tileResults: { markers: any[] }[] = [];
    const allCells: { key: string; count: number }[] = [];
    const conc = Math.max(1, Math.min(8, Number(process.env.TILE_CONCURRENCY) || 6));
    await mapWithConcurrency(tiles, conc, async (t) => {
        const { tileKey, filters } = prepareTileQuery(t, { scope, sort: sortStr, ...rest } as any);
        // Distributed singleflight: N Next instances coalesce on the same
        // tile key via Redis lock (vs per-process Map only).
        const { value: cachedOrComputed } = await singleflightCompute<any>(
          tileKey,
          ttl,
          async () => {
            const { must, filters: baseFilters } = buildFiltersForTiles({ ...filters, sort: sortStr, scope }, String(scope));
            void filters;
            const tb = tileToBounds(t.z, t.x, t.y);
            const allFilters = quantileRange ? [...baseFilters, quantileRange] : baseFilters;
            const r = await queryTileMarkersForBounds({
              tileBounds: tb,
              must,
              filters: allFilters,
              scope: String(scope),
              sort: sortStr,
              zoom: Number(zoom) || 10,
              withPercentiles: flags.quantileFilter,
              timeoutMs: 4000,
            }).catch((e) => {
              logger.warn('tile agg failed', e);
              return null;
            });
            if (!r) return null;
            return { markers: r.markers, cells: r.cells, took: r.took };
          }
        );
        const payload = cachedOrComputed;
        if (payload) {
          tileResults.push(payload);
          if (Array.isArray((payload as any).cells)) allCells.push(...(payload as any).cells);
        }
      });

    let merged = mergeTileMarkers(tileResults, { minLat, maxLat, minLng, maxLng }, sortStr, 500);
    // Same contract as map-data: narrowed population ≤500 -> exact sort-aware
    // top-K; >500 -> hybrid fill toward ~500. Fill reps are clipped to the
    // viewport (appended post-merge, bypassing mergeTileMarkers' clip).
    try {
      const { clipToViewport } = await import('@/lib/tileMerge');
      const clipFill = (markers: any[]) => clipToViewport(markers, { minLat, maxLat, minLng, maxLng });
      let tileDocTotal = 0;
      for (const tr of tileResults as any[]) {
        for (const c of ((tr as any).cells || [])) tileDocTotal += c.count || 0;
      }
      const { buildFiltersForTiles: bff } = await import('@/lib/esTileFilters');
      const bf = bff({ scope, sort: sortStr, ...rest, bounds: { minLat, maxLat, minLng, maxLng } } as any, String(scope));
      const fAll = quantileRange ? [...bf.filters, quantileRange] : bf.filters;
      const { querySortFillForBounds, fillMarkerDeficit } = await import('@/lib/esTileMarkers');
      if (tileDocTotal > 0 && tileDocTotal <= 500) {
        const fr = await querySortFillForBounds({
          must: bf.must,
          filters: fAll,
          scope: String(scope),
          sort: sortStr,
          size: Math.min(500, tileDocTotal),
          timeoutMs: 4000,
        }).catch(() => null);
        if (fr && fr.markers.length > 0) merged = fillMarkerDeficit([], clipFill(fr.markers), tileDocTotal, 500);
      } else {
        const want = Math.min(500, tileDocTotal) - merged.length;
        if (want > 0 && tileDocTotal > 500) {
          const fr = await querySortFillForBounds({
            must: bf.must,
            filters: fAll,
            scope: String(scope),
            sort: sortStr,
            size: Math.min(500, want + 50),
            timeoutMs: 4000,
          }).catch(() => null);
          if (fr && fr.markers.length > 0) merged = fillMarkerDeficit(merged, clipFill(fr.markers), tileDocTotal, 500);
        }
      }
    } catch { /* best-effort */ }
    const ms = Date.now() - t0;
    logger.info('map-tiles served', { tiles: tiles.length, markers: merged.length, cells: allCells.length, ms, zoom, scope, sort: sortStr });
    return NextResponse.json(
      { markers: merged, cells: allCells, zoom, tiles: tiles.map((t) => `${t.z}/${t.x}/${t.y}`) },
      { headers: { 'Cache-Control': `public, s-maxage=${sMax}, stale-while-revalidate=60`, 'X-ES-Took': `${ms}` } }
    );
  } catch (e: any) {
    logger.error('map-tiles error', e?.message || e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Scale-ready CDN path: GET is cacheable by stock CDNs (POST is not).
// Same tile-aligned keys (md:v5:t:z/x/y:filterHash:sort) so edge hits share
// across users. Clients should prefer GET for unfiltered/base pans; POST
// remains for complex filtered bodies.
export async function GET(req: NextRequest) {
  try {
    const identifier = getRateLimitIdentifier(req);
    const { allowed } = await checkMapRateLimit(identifier);
    if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    const sp = req.nextUrl.searchParams;
    const num = (k: string) => {
      const v = sp.get(k);
      return v == null ? undefined : Number(v);
    };
    const bounds = { minLat: num('minLat'), maxLat: num('maxLat'), minLng: num('minLng'), maxLng: num('maxLng') };
    if (![bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng].every(Number.isFinite)) {
      return NextResponse.json({ error: 'bounds (minLat,maxLat,minLng,maxLng) required' }, { status: 400 });
    }
    const forward = new Request(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(req.headers.get('x-forwarded-for') ? { 'x-forwarded-for': req.headers.get('x-forwarded-for') as string } : {}) },
      body: JSON.stringify({
        bounds,
        zoom: num('zoom') ?? 10,
        scope: sp.get('scope') || 'both',
        sort: sp.get('sort') || 'newest',
        ...(sp.get('query') ? { query: sp.get('query') } : {}),
        ...(sp.get('listingPurpose') ? { listingPurpose: sp.get('listingPurpose') } : {}),
        ...(sp.get('minPrice') ? { minPrice: num('minPrice') } : {}),
        ...(sp.get('maxPrice') ? { maxPrice: num('maxPrice') } : {}),
      }),
    }) as NextRequest;
    // Reuse POST path (single implementation) — CDN caches this GET URL.
    return POST(forward as NextRequest);
  } catch (e: any) {
    logger.error('map-tiles GET error', e?.message || e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
