import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable, recordEsSuccess } from '@/lib/elasticsearch';
import { queryESListings, queryESMapMarkers } from '@/lib/esQueryBuilder';
import { queryTileMarkersForBounds } from '@/lib/esTileMarkers';
import { mergeTileMarkers } from '@/lib/tileMerge';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { prepareMapQuery, prepareTileQuery } from '@/lib/filterNormalize';
import { viewportCoveringTiles, tileToBounds, redisTTLForSort, cdnSMaxAgeForSort } from '@/lib/mapTiles';
import { flags } from '@/lib/flags';

function cacheHeadersForSort(sort?: string) {
  const sMax = cdnSMaxAgeForSort(sort);
  return { 'Cache-Control': `public, s-maxage=${sMax}, stale-while-revalidate=60` };
}

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
      lat, lng, radiusKm, polygon, polygons,
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
    // P2+: tile keys md:v5:t:z/x/y:filterHash:sortHash written alongside (reversible).
    const { bounds, filters, markerKey, listKey } = prepareMapQuery(
      { minLat, maxLat, minLng, maxLng },
      {
        query, location, minPrice, maxPrice, propertyType, bhkType,
        minBedrooms, maxBedrooms,
        listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
        lat, lng, radiusKm, scope, sort, pageSize, cursor, polygon, polygons,
      }
    );

    const sortStr = typeof sort === 'string' ? sort : 'newest';
    const CACHE_HEADERS = cacheHeadersForSort(sortStr);
    const listTTL = redisTTLForSort(sortStr);
    const markerTTL = redisTTLForSort(sortStr);

    // P2: covering tiles for cache reuse (additive, never single-center-tile).
    const tiles = flags.tileCacheV5 ? viewportCoveringTiles(bounds, zoom) : [];
    const tileEntries = flags.tileCacheV5
      ? tiles.map((t) => {
          const q = prepareTileQuery(t, {
            query, location, minPrice, maxPrice, propertyType, bhkType,
            minBedrooms, maxBedrooms,
            listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
            lat, lng, radiusKm, scope, sort: sortStr, polygon, polygons,
          });
          return { tile: t, ...q };
        })
      : [];

    // Marker sampling seed identifies the exact normalized viewport+filters.
    const esParams = { ...filters, bounds, seedKey: markerKey };
    const t0 = Date.now();
    let listCacheHit = false;
    let markerCacheHit = false;

    // Serve fully-cached legacy responses without touching ES at all (including
    // when ES is down — cache is the resilience layer).
    const [cachedList, cachedMarkers] = await Promise.all([
      cacheGet<any>(listKey),
      cacheGet<any>(markerKey),
    ]);
    listCacheHit = !!cachedList;
    markerCacheHit = !!cachedMarkers;
    if (cachedList && cachedMarkers) {
      logger.info('map-data cache hit', { listKey, markerKey, ms: Date.now() - t0, zoom, scope });
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
          withoutPurposeTotal: cachedList.withoutPurposeTotal ?? null,
          zoom,
        },
        {
          headers: {
            ...CACHE_HEADERS,
            'X-Cache': 'list:HIT,markers:HIT',
            'X-ES-Took': '0',
          },
        }
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

    // Runtime quantiles for sort-aware tile narrowing (fallback = no-range).
    // First request per region×field computes one size:0 TDigest (coalesced via
    // module singleflight), cached 24h+jitter. No cron required.
    // popular has no deterministic field -> plain per-cell top-1 (newest reps).
    // Zoom gate: narrowing only at overview zooms (z<10). Zoomed-in users see
    // the full set (tiles+fill to ~500); overview users see the sort-relevant
    // concentration. Without the gate, a p90 cut on a 23-home viewport would
    // hide 21 pins behind "show biggest only" — misleading at street level.
    let quantileRange: any | null = null;
    if (flags.quantileFilter && sortStr !== 'popular' && Number(zoom) < 10) {
      try {
        const { getOrComputeQuantileThresholds, quantileRangeForSort: qRange, sortFieldForQuantile: qField } = await import('@/lib/quantiles');
        const qf = qField(sortStr, String(scope || 'both'));
        if (qf) {
          const qIndex =
            String(scope || 'both') === 'projects'
              ? (await import('@/lib/elasticsearch')).PROJECTS_INDEX_ALIAS
              : String(scope || 'both') === 'properties'
                ? (await import('@/lib/elasticsearch')).ES_INDEX_ALIAS
                : [(await import('@/lib/elasticsearch')).ES_INDEX_ALIAS, (await import('@/lib/elasticsearch')).PROJECTS_INDEX_ALIAS];
          const qBase: any[] = [{ term: { status: 'available' } }];
          if (typeof listingPurpose === 'string' && /rent|lease|\bpg\b/i.test(listingPurpose)) {
            qBase.push({ bool: { must_not: { term: { entity_type: 'project' } } } });
          }
          const q = await getOrComputeQuantileThresholds(bounds, sortStr, String(scope || 'both'), {
            listingPurpose: typeof listingPurpose === 'string' ? listingPurpose : undefined,
            baseMust: [],
            baseFilters: qBase,
            index: qIndex,
            timeoutMs: 2000,
            runAgg: async (o: any) => {
              const { getElasticsearchClient: getEs } = await import('@/lib/elasticsearch');
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
          quantileRange = qRange(q, sortStr, String(scope || 'both'));
        }
      } catch { quantileRange = null; }
    }

    // P4 helper note: tile MAP uses queryTileMarkersForBounds per covering tile
    // (Promise.all, singleflight per tile key). Legacy random_score fallback below.

    const listStart = Date.now();
    const markerStart = Date.now();
    const [searchResult, markers] = await Promise.all([
      singleflight(listKey, async () => {
        const cached = await cacheGet<any>(listKey);
        if (cached) { listCacheHit = true; return cached; }
        // P6: msearch path shares filter-cache lookup (singleflight already coalesces);
        // keep Promise.all for now — msearch batching is transport optimization.
        const result = await queryESListings({ ...esParams, cursor, pageSize, sort: sortStr, scope }).catch((err) => {
          logger.warn('ES listing query failed', err);
          return null;
        });
        // NEVER cache error responses. Tiered TTL: newest fresh, price stable.
        if (result) await cacheSet(listKey, result, listTTL);
        return result;
      }),
      singleflight(markerKey, async () => {
        const cached = await cacheGet<any>(markerKey);
        if (cached) { markerCacheHit = true; return cached; }
        // P4 cutover: try tile MAP first, fallback to legacy random_score.
        if (flags.mapTilesV1 && tileEntries.length > 0) {
          try {
            const tileResults: { markers: any[] }[] = [];
            // Bound fan-out: max 12 tiles already clamped in viewportCoveringTiles.
            await Promise.all(
              tileEntries.map((te) =>
                singleflight(te.tileKey, async () => {
                  const tcached = await cacheGet<any>(te.tileKey);
                  if (tcached) return tcached;
                  // Dynamic import to avoid pulling ES client on cache-hit-only paths.
                  const { queryTileMarkersForBounds: qtm } = await import('@/lib/esTileMarkers');
                  const { tileToBounds: t2b } = await import('@/lib/mapTiles');
                  // Reconstruct must/filters from esParams via builder (same population).
                  const { buildFiltersForTiles } = await import('@/lib/esTileFilters').catch(() => ({ buildFiltersForTiles: null as any }));
                  let must: any[] = [];
                  let baseFilters: any[] = [];
                  if (buildFiltersForTiles) {
                    const bf = buildFiltersForTiles({ ...filters, sort: sortStr, scope }, String(scope || 'both'));
                    must = bf.must; baseFilters = bf.filters;
                  }
                  const tb = t2b(te.tile.z, te.tile.x, te.tile.y);
                  const allFilters = quantileRange ? [...baseFilters, quantileRange] : baseFilters;
                  const r = await (qtm as any)({
                    tileBounds: tb,
                    must,
                    filters: allFilters,
                    scope: String(scope || 'both'),
                    sort: sortStr,
                    zoom: Number(zoom) || 10,
                    withPercentiles: flags.quantileFilter,
                    timeoutMs: 4000,
                  }).catch(() => null);
                  const payload = r ? { markers: r.markers, cells: r.cells, took: r.took } : null;
                  if (payload) await cacheSet(te.tileKey, payload, markerTTL);
                  return payload;
                }).then((payload: any) => {
                  if (payload && Array.isArray(payload.markers)) tileResults.push(payload);
                })
              )
            );
            if (tileResults.length > 0) {
              const { mergeTileMarkers: mtm, clipToViewport: clipVP } = await import('@/lib/tileMerge');
              const { buildFiltersForTiles: bff2 } = await import('@/lib/esTileFilters').catch(() => ({ buildFiltersForTiles: null as any }));
              const { querySortFillForBounds: qfill, fillMarkerDeficit: fmd } = await import('@/lib/esTileMarkers');
              // Without the shared builder there is no safe viewport population
              // (an unfiltered fill would leak global top-K into the viewport),
              // so skip the tile path entirely and use legacy below.
              if (!bff2) throw new Error('tile filter builder unavailable');
              // Viewport-level population for the fill (tile loop filters carry
              // per-tile boxes instead). Quantile range included so fill matches
              // the narrowed tile population exactly (anti-ratchet: never
              // compute thresholds here, only reuse the one above).
              let vMust: any[] = [];
              let vFilters: any[] = [];
              try {
                const bf2 = bff2({ ...filters, bounds, sort: sortStr, scope }, String(scope || 'both'));
                vMust = bf2.must;
                vFilters = quantileRange ? [...bf2.filters, quantileRange] : bf2.filters;
              } catch { throw new Error('tile viewport filters unavailable'); }
              // Fill reps bypass mergeTileMarkers' clip (appended post-merge),
              // so clip them here — never paint outside the viewport
              // (antimeridian/world-wrap edge cases).
              const clipFill = (markers: any[]) => clipVP(markers, bounds);
              let merged = mtm(tileResults, bounds, sortStr, 500);
              // Effective (possibly quantile-narrowed) population from tile cells.
              let tileDocTotal = 0;
              for (const tr of tileResults as any[]) {
                for (const c of (tr.cells || [])) tileDocTotal += c.count || 0;
              }
              if (tileDocTotal > 0 && tileDocTotal <= 500) {
                // Narrowed population fits: exact sort-aware top-K (replaces the
                // old sort-blind legacy random sample, which could show any 500).
                try {
                  const fr = await (qfill as any)({
                    must: vMust,
                    filters: vFilters,
                    scope: String(scope || 'both'),
                    sort: sortStr,
                    size: Math.min(500, tileDocTotal),
                    timeoutMs: 4000,
                  }).catch(() => null);
                  if (fr && Array.isArray(fr.markers) && fr.markers.length > 0) {
                    merged = (fmd as any)([], clipFill(fr.markers), tileDocTotal, 500);
                  }
                } catch { /* keep tile reps below */ }
              } else if (merged.length > 0 && tileDocTotal > 500) {
                // Hybrid fill toward ~500: tile reps give spread, one bounded
                // indexed-sort query (no scoring/aggs/count) adds global rank.
                try {
                  const want = Math.min(500, tileDocTotal) - merged.length;
                  if (want > 0) {
                    const fr = await (qfill as any)({
                      must: vMust,
                      filters: vFilters,
                      scope: String(scope || 'both'),
                      sort: sortStr,
                      size: Math.min(500, want + 50),
                      timeoutMs: 4000,
                    }).catch(() => null);
                    if (fr && Array.isArray(fr.markers) && fr.markers.length > 0) {
                      merged = (fmd as any)(merged, clipFill(fr.markers), tileDocTotal, 500);
                    }
                  }
                } catch { /* fill is best-effort; tile reps still served */ }
              }
              if (merged.length > 0) {
                // Write legacy key too (dual-write keeps instant rollback warm).
                await cacheSet(markerKey, merged, markerTTL);
                // P3 shadow: compare vs legacy in background (log-only).
                if (flags.tileShadow && Math.random() * 100 < flags.tileShadowPct) {
                  queryESMapMarkers(esParams).then((legacy: any) => {
                    const overlap = legacy && merged ? merged.filter((m: any) => legacy.some((l: any) => l.id === m.id)).length : 0;
                    logger.info('tile shadow compare', { tileCount: merged.length, legacyCount: legacy?.length || 0, overlap, zoom, scope });
                  }).catch(() => {});
                }
                (merged as any)._tileServed = true;
                return merged;
              }
              // tileDocTotal==0 with tileResults present (all mapping failures):
              // fall through to legacy below.
            }
          } catch (e) {
            logger.warn('tile MAP failed, falling back to legacy', e);
          }
        }
        const result = await queryESMapMarkers(esParams).catch((err) => {
          logger.warn('ES map marker query failed', err);
          return null;
        });
        if (result) await cacheSet(markerKey, result, markerTTL);
        // P3 shadow (legacy-served path): run tile agg log-only for tuning.
        if (flags.tileShadow && result && Math.random() * 100 < Math.min(flags.tileShadowPct, 10)) {
          (async () => {
            try {
              if (tileEntries.length === 0) return;
              const te = tileEntries[0];
              const { tileToBounds: t2b } = await import('@/lib/mapTiles');
              const tb = t2b(te.tile.z, te.tile.x, te.tile.y);
              logger.info('tile shadow (legacy served)', { tileKey: te.tileKey, legacyCount: (result as any[]).length, bounds: tb });
            } catch { /* log-only */ }
          })();
        }
        return result;
      }),
    ]);
    const listMs = Date.now() - listStart;
    const markerMs = Date.now() - markerStart;

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

    const totalMs = Date.now() - t0;
    logger.info('map-data served', {
      listMs, markerMs, totalMs,
      listHit: listCacheHit, markerHit: markerCacheHit,
      total: (searchResult as any).total,
      totalRelation: (searchResult as any).totalRelation,
      markerCount: Array.isArray(markers) ? markers.length : 0,
      tileServed: (markers as any)._tileServed === true,
      zoom, scope, sort: sortStr,
    });

    const cleanMarkers = Array.isArray(markers) ? markers : [];
    // Strip internal flag before serializing (non-enumerable guard).
    if ((cleanMarkers as any)._tileServed) delete (cleanMarkers as any)._tileServed;

    return NextResponse.json(
      {
        // For map dots — up to 500 lightweight markers (id, lat, lon, price)
        markers: cleanMarkers,

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
        // Intent-aware empty state ("N available under other intents")
        withoutPurposeTotal: searchResult.withoutPurposeTotal ?? null,

        // Metadata
        zoom,
      },
      {
        headers: {
          ...CACHE_HEADERS,
          'X-Cache': `list:${listCacheHit ? 'HIT' : 'MISS'},markers:${markerCacheHit ? 'HIT' : 'MISS'}`,
          'X-ES-Took': `${listMs + markerMs}`,
        },
      }
    );
  } catch (error: any) {
    // Client aborts are routine here (cancel-on-new + 400ms pan debounce):
    // don't log them as errors, just acknowledge the disconnect.
    if (req.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return NextResponse.json({ error: 'aborted' }, { status: 499 });
    }
    logger.error('Map data API error', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
