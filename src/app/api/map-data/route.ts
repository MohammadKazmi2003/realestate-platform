import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable, recordEsSuccess } from '@/lib/elasticsearch';
import { queryESListings, queryESMapMarkers } from '@/lib/esQueryBuilder';
import { cellsAreUnclustered, stripInternalMarkerFields } from '@/lib/tileMerge';
import { cacheGet, singleflightCompute } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { prepareMapQuery, prepareTileQuery } from '@/lib/filterNormalize';
import {
  viewportCoveringTiles,
  coveringTileUnionBounds,
  redisTTLForSort,
  cdnSMaxAgeForSort,
} from '@/lib/mapTiles';
import { flags } from '@/lib/flags';
import { mapWithConcurrency } from '@/lib/concurrency';
import { attachTiming, makeServerTiming } from '@/lib/routeTiming';
import { getAdminRegion, getAdminRegionLite } from '@/lib/adminRegionsServer';

function cacheHeadersForSort(sort?: string) {
  const sMax = cdnSMaxAgeForSort(sort);
  return { 'Cache-Control': `public, s-maxage=${sMax}, stale-while-revalidate=60` };
}

// AD8: no required in-process state. Request coalescing is handled by
// singleflightCompute (in-process L1 map + Redis SET NX L2), so N instances
// share one dedup instead of each running its own — an instance-local Map is
// invisible to every other pod and multiplies backend load exactly at peak.

export async function POST(req: NextRequest) {
  const timing = makeServerTiming();
  try {
    // Map rate limiter (separate from search + autocomplete)
    const identifier = getRateLimitIdentifier(req);
    const { allowed } = await checkMapRateLimit(identifier);
    timing.record('rl');
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
      state, markers: markersParam,
    } = body;

    if (!rawBounds) {
      return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    }

    // Interactive state selection: the client sends a stable admin-1 id and the
    // server injects the SAME canonical geometry the outline renders (one source
    // of truth for filter + outline, and GET-friendly URLs without polygon
    // payloads). State selection supersedes any raw boundary the client sent.
    let effectivePolygon = polygon;
    let effectivePolygons = polygons;
    let regionShapes: { outer: { lat: number; lng: number }[]; holes: { lat: number; lng: number }[][] }[] | undefined;
    let regionToken: string | undefined;
    if (typeof state === 'string' && state.trim()) {
      const meta = getAdminRegionLite(state.trim());
      if (!meta) {
        return NextResponse.json({ error: `unknown state: ${state}` }, { status: 400 });
      }
      const region = getAdminRegion(state.trim());
      if (!region) {
        // Canonical geometry missing/corrupt: refuse rather than filter by a
        // different shape than the client draws.
        return NextResponse.json({ error: 'state geometry unavailable' }, { status: 503 });
      }
      regionShapes = region.shapes;
      regionToken = region.token;
      effectivePolygon = undefined;
      effectivePolygons = undefined;
    }

    // State-overview mode: below the tenant's overview zoom the map shows only
    // state outlines, so the expensive O(matches) tile grid + fill are skipped
    // entirely. Accepts false from JSON or 'false'/'0' from the GET wrapper.
    const markersEnabled = !(
      markersParam === false || markersParam === 'false' || markersParam === '0'
    );

    const { minLat, maxLat, minLng, maxLng } = rawBounds;
    if (minLat == null || maxLat == null || minLng == null || maxLng == null) {
      return NextResponse.json({ error: 'Invalid bounds' }, { status: 400 });
    }

    // AD1: the cacheable/shared unit is the COVERING-TILE UNION, not the raw
    // viewport. Every pan that resolves to the same z/x/y set hashes to the
    // SAME marker/list key and runs the SAME geo filter — so cache entries are
    // reused across users instead of minted one per pan. The union is a
    // superset of the viewport (AD5), so a hit can never hide a listing.
    // Keys are 64-bit hashed under md:v5:*. Filters are normalized once and
    // feed both the ES query and the hash (never hash-only).
    const viewportClamped = {
      minLat: Math.max(-85.0511, Math.min(85.0511, Number(minLat))),
      maxLat: Math.max(-85.0511, Math.min(85.0511, Number(maxLat))),
      minLng: Math.max(-180, Math.min(180, Number(minLng))),
      maxLng: Math.max(-180, Math.min(180, Number(maxLng))),
    };
    if (viewportClamped.minLng > viewportClamped.maxLng) {
      viewportClamped.minLng = -180;
      viewportClamped.maxLng = 180;
    }
    const unionBounds = coveringTileUnionBounds(viewportClamped, Number(zoom) || 10);
    const { bounds, filters, markerKey, listKey } = prepareMapQuery(
      unionBounds,
      {
        query, location, minPrice, maxPrice, propertyType, bhkType,
        minBedrooms, maxBedrooms,
        listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
        lat, lng, radiusKm, scope, sort, pageSize, cursor,
        polygon: effectivePolygon, polygons: effectivePolygons,
        polygonsWithHoles: regionShapes, regionToken,
      }
    );

    const sortStr = typeof sort === 'string' ? sort : 'newest';
    const CACHE_HEADERS = cacheHeadersForSort(sortStr);
    const listTTL = redisTTLForSort(sortStr);
    const markerTTL = redisTTLForSort(sortStr);

    // P2: covering tiles for cache reuse (additive, never single-center-tile).
    // Skipped entirely in state-overview mode (no markers requested).
    const tiles = markersEnabled && flags.tileCacheV5 ? viewportCoveringTiles(bounds, zoom) : [];
    const tileEntries = markersEnabled && flags.tileCacheV5
      ? tiles.map((t) => {
          const q = prepareTileQuery(t, {
            query, location, minPrice, maxPrice, propertyType, bhkType,
            minBedrooms, maxBedrooms,
            listingPurpose, amenities, furnishings, bathrooms, minArea, maxArea,
            lat, lng, radiusKm, scope, sort: sortStr,
            polygon: effectivePolygon, polygons: effectivePolygons,
            polygonsWithHoles: regionShapes, regionToken,
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
    // when ES is down — cache is the resilience layer). In state-overview mode
    // markers are intentionally not requested, so only the list key gates the
    // full-hit path.
    const [cachedList, cachedMarkers] = await Promise.all([
      cacheGet<any>(listKey),
      markersEnabled ? cacheGet<any>(markerKey) : Promise.resolve(null),
    ]);
    timing.record('cache');
    listCacheHit = !!cachedList;
    markerCacheHit = !!cachedMarkers;
    if (cachedList && (cachedMarkers || !markersEnabled)) {
      logger.info('map-data cache hit', { listKey, markerKey, ms: Date.now() - t0, zoom, scope, markers: markersEnabled });
      return attachTiming(NextResponse.json(
        {
          markers: markersEnabled ? cachedMarkers : [],
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
            'X-Cache': `list:HIT,markers:${markersEnabled ? 'HIT' : 'SKIP'}`,
            'X-ES-Took': '0',
          },
        }
      ), timing);
    }

    const esAvailable = await isEsAvailable();
    timing.record('ping');
    if (!esAvailable) {
      return attachTiming(NextResponse.json(
        {
          error: 'Search services temporarily unavailable',
          results: [], markers: [], total: 0, totalRelation: undefined,
          nextCursor: null, propertyTotal: 0, projectTotal: 0,
          projectGroups: [], zoom,
        },
        { status: 503 }
      ), timing);
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
    // Quantiles only narrow the tile/fill populations; in state-overview mode
    // (markers disabled) there is nothing to narrow, so skip the lookup.
    if (markersEnabled && flags.quantileFilter && sortStr !== 'popular' && Number(zoom) < 10) {
      const tQuantile = performance.now();
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
      timing.record('quantile', performance.now() - tQuantile);
    }

    // P4 helper note: tile MAP uses queryTileMarkersForBounds per covering tile
    // (Promise.all, singleflight per tile key). Legacy random_score fallback below.

    const listStart = Date.now();
    const markerStart = Date.now();
    // Whether THIS marker computation was served by the tile path — recorded
    // outside the compute closure so the cached payload stays clean and the
    // in-flight copy can still be tagged (Invariant 3: never persist internals).
    let tileServedByCompute = false;
    const tList = performance.now();
    const tMarkers = performance.now();
    const [searchResult, markers] = await Promise.all([
      // AD8: coalesce across INSTANCES, not just this process. The list key is
      // shared by every user at the same tile union + filters, so N pods each
      // running their own ES query is exactly the redundant work AD2 forbids.
      // singleflightCompute does cache-hit → in-process dedup → Redis SET NX,
      // and caches the winner's result (never an error/null, Invariant 4).
      singleflightCompute<any>(listKey, listTTL, async () => {
        const result = await queryESListings({ ...esParams, cursor, pageSize, sort: sortStr, scope }).catch((err) => {
          logger.warn('ES listing query failed', err);
          return null;
        });
        return result;
      }).then((r) => {
        if (r.status === 'hit') listCacheHit = true;
        return r.value;
      }).finally(() => timing.record('list', performance.now() - tList)),
      // AD8: markers are the most-shared payload on the site — every user at the
      // same tile union + filters wants the same 500 dots. Coalesce across pods
      // via Redis so N instances don't each run the tile fan-out.
      // State-overview mode (below overviewMaxZoom) requests none at all.
      markersEnabled
        ? singleflightCompute<any>(markerKey, markerTTL, async () => {
        tileServedByCompute = false;
        // P4 cutover: try tile MAP first, fallback to legacy random_score.
        if (flags.mapTilesV1 && tileEntries.length > 0) {
          try {
            const tileResults: { markers: any[] }[] = [];
            // Bound fan-out: max 12 tiles already clamped in viewportCoveringTiles.
            await mapWithConcurrency(
              tileEntries,
              Math.max(1, Math.min(8, Number(process.env.TILE_CONCURRENCY) || 6)),
              async (te) =>
                singleflightCompute<any>(te.tileKey, markerTTL, async () => {
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
                          timeoutMs: 4000,
                  }).catch(() => null);
                  // singleflightCompute caches non-null payloads itself and
                  // never caches an error/empty result (Invariant 4).
                  return r ? { markers: r.markers, cells: r.cells, took: r.took } : null;
                }).then(({ value: payload }: any) => {
                  if (payload && Array.isArray(payload.markers)) tileResults.push(payload);
                })
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
              const allTileCells: any[] = [];
              for (const tr of tileResults as any[]) {
                for (const c of (tr.cells || [])) {
                  tileDocTotal += c.count || 0;
                  allTileCells.push(c);
                }
              }
              // Invariant 1: when no cell holds more than one doc, the tile reps
              // already ARE the whole population — the top-K is exact, so the
              // fill query would be a pure extra ES round trip on every request.
              const repsExact =
                cellsAreUnclustered(allTileCells) && merged.length >= Math.min(500, tileDocTotal);
              if (repsExact) {
                // skip fill: reps are the exact (<=500) population
              } else if (tileDocTotal > 0 && tileDocTotal <= 500) {
                // Narrowed population fits: exact sort-aware top-K (replaces the
                // old sort-blind legacy random sample, which could show any 500).
                try {
                  const tFill = performance.now();
                  const fr = await (qfill as any)({
                    must: vMust,
                    filters: vFilters,
                    scope: String(scope || 'both'),
                    sort: sortStr,
                    size: Math.min(500, tileDocTotal),
                    timeoutMs: 4000,
                  }).catch(() => null);
                  timing.record('fill', performance.now() - tFill);
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
                    const tFill = performance.now();
                    const fr = await (qfill as any)({
                      must: vMust,
                      filters: vFilters,
                      scope: String(scope || 'both'),
                      sort: sortStr,
                      size: Math.min(500, want + 50),
                      timeoutMs: 4000,
                    }).catch(() => null);
                    timing.record('fill', performance.now() - tFill);
                    if (fr && Array.isArray(fr.markers) && fr.markers.length > 0) {
                      merged = (fmd as any)(merged, clipFill(fr.markers), tileDocTotal, 500);
                    }
                  }
                } catch { /* fill is best-effort; tile reps still served */ }
              }
              if (merged.length > 0) {
                // singleflightCompute writes markerKey itself (clean, no _tileServed).
                // P3 shadow: compare vs legacy in background (log-only).
                if (flags.tileShadow && Math.random() * 100 < Math.min(flags.tileShadowPct, 10)) {
                  queryESMapMarkers(esParams).then((legacy: any) => {
                    const overlap = legacy && merged ? merged.filter((m: any) => legacy.some((l: any) => l.id === m.id)).length : 0;
                    logger.info('tile shadow compare', { tileCount: merged.length, legacyCount: legacy?.length || 0, overlap, zoom, scope });
                  }).catch(() => {});
                }
                tileServedByCompute = true;
                // Strip BEFORE returning: singleflightCompute caches this value
                // verbatim, so internal rank keys must never enter the cache.
                return stripInternalMarkerFields(merged);
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
        // singleflightCompute caches the result (never null/errors — Invariant 4).
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
        // Strip internal keys before singleflightCompute caches this payload.
        return stripInternalMarkerFields(result);
      }).then((r) => {
        if (r.status === 'hit') markerCacheHit = true;
        const v = r.value;
        if (v && tileServedByCompute) (v as any)._tileServed = true;
        return v;
      }).finally(() => timing.record('markers', performance.now() - tMarkers))
        : Promise.resolve([] as any[]),
    ]);
    const listMs = Date.now() - listStart;
    const markerMs = Date.now() - markerStart;

    // Signal ES success to circuit breaker (if ES query succeeded)
    if (searchResult && markers) recordEsSuccess();

    if (!searchResult || !markers) {
      return attachTiming(NextResponse.json(
        {
          error: 'Search services temporarily unavailable',
          results: [], markers: [], total: 0, totalRelation: undefined,
          nextCursor: null, propertyTotal: 0, projectTotal: 0,
          projectGroups: [], zoom,
        },
        { status: 503 }
      ), timing);
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

    const tSerialize = performance.now();
    const res = NextResponse.json(
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
          'X-Cache': `list:${listCacheHit ? 'HIT' : 'MISS'},markers:${markersEnabled ? (markerCacheHit ? 'HIT' : 'MISS') : 'SKIP'}`,
          'X-ES-Took': `${listMs + markerMs}`,
        },
      }
    );
    timing.record('serialize', performance.now() - tSerialize);
    return attachTiming(res, timing);
  } catch (error: any) {
    // Client aborts are routine here (cancel-on-new + 400ms pan debounce):
    // don't log them as errors, just acknowledge the disconnect.
    if (req.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return NextResponse.json({ error: 'aborted' }, { status: 499 });
    }
    // JSON.stringify(Error) === '{}' — log the message and stack explicitly or
    // every failure surfaces as an empty object and hides the real cause.
    logger.error('Map data API error', {
      name: (error as any)?.name,
      message: (error as any)?.message,
      stack: (error as any)?.stack?.split('\n').slice(0, 6).join(' | '),
      cause: (error as any)?.cause,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Next.js stamps `Vary: rsc, next-router-state-tree, next-router-prefetch,
 * next-router-segment-prefetch` on every route handler. Those exist for React
 * Server Components negotiation — an API JSON body never varies on them (verified
 * by hashing the response with and without the headers). A CDN keyed on them
 * stores one entry per RSC header combination that no client ever sends, so the
 * edge cache never shares. Normalise to the header that actually matters.
 */
function edgeCacheable(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Vary', 'Accept-Encoding');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Scale-ready edge absorption (Scaling Playbook step 4): the POST handler is the
// single implementation; this GET wrapper exists so a stock CDN can cache it.
// POST is never cached by a CDN, which is why warm pans were hitting the origin.
//
// Only the common filter set travels in the URL — boundaries (polygon/polygons)
// are rejected here rather than silently dropped, because a cached response that
// ignored a filter would serve the wrong population for the whole s-maxage.
export async function GET(req: NextRequest) {
  try {
    const identifier = getRateLimitIdentifier(req);
    const { allowed } = await checkMapRateLimit(identifier);
    if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

    const sp = req.nextUrl.searchParams;
    const num = (k: string) => {
      const v = sp.get(k);
      return v == null || v === '' ? undefined : Number(v);
    };
    const bounds = { minLat: num('minLat'), maxLat: num('maxLat'), minLng: num('minLng'), maxLng: num('maxLng') };
    if (![bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng].every(Number.isFinite)) {
      return NextResponse.json({ error: 'bounds (minLat,maxLat,minLng,maxLng) required' }, { status: 400 });
    }
    if (sp.has('polygon') || sp.has('polygons') || sp.has('regionToken') || sp.has('polygonsWithHoles') || sp.has('cursor')) {
      return NextResponse.json(
        { error: 'polygon and cursor filters require POST /api/map-data' },
        { status: 400 }
      );
    }

    const ARRAY_FIELDS = ['amenities', 'furnishings'];
    const body: Record<string, unknown> = {
      bounds,
      zoom: num('zoom') ?? 10,
      scope: sp.get('scope') || 'both',
      sort: sp.get('sort') || 'newest',
      pageSize: num('pageSize') ?? 24,
    };
    for (const [k, v] of Array.from(sp.entries())) {
      if (['minLat', 'maxLat', 'minLng', 'maxLng', 'zoom', 'scope', 'sort', 'pageSize'].includes(k)) continue;
      if (v === '') continue;
      body[k] = ARRAY_FIELDS.includes(k)
        ? v.split(',').map((x: string) => x.trim()).filter((x: string) => x.length > 0)
        : v;
    }

    const forward = new Request(req.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(req.headers.get('x-forwarded-for')
          ? { 'x-forwarded-for': req.headers.get('x-forwarded-for') as string }
          : {}),
      },
      body: JSON.stringify(body),
    }) as NextRequest;
    return edgeCacheable(await POST(forward as NextRequest));
  } catch (e: any) {
    logger.error('map-data GET error', e?.message || e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
