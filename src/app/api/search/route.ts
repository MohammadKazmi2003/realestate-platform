import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, recordEsSuccess, recordEsFailure } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkSearchRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { searchQuerySchema } from '@/lib/validation';
import { logger } from '@/lib/logger';
import { enqueueAnalytics } from '@/lib/events';
import { normalizeBoundaryPolygons } from '@/lib/filterNormalize';
import { buildFilters, getListingCountsFor, indexForScope } from '@/lib/esQueryBuilder';
import { flags } from '@/lib/flags';
import { attachTiming, makeServerTiming } from '@/lib/routeTiming';
import { getAdminRegion, getAdminRegionLite } from '@/lib/adminRegionsServer';

function roundBounds(b: any) {
  if (!b) return b;
  return {
    minLat: Math.round(b.minLat * 100) / 100,
    maxLat: Math.round(b.maxLat * 100) / 100,
    minLng: Math.round(b.minLng * 100) / 100,
    maxLng: Math.round(b.maxLng * 100) / 100,
  };
}

export async function POST(req: NextRequest) {
  const timing = makeServerTiming();
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkSearchRateLimit(identifier);
  timing.record('rl');
  if (!allowed) {
    return NextResponse.json({ error: 'Too many search requests. Please slow down.' }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = searchQuerySchema.safeParse(body);
    if (!parsed.success) {
      logger.warn('Search API validation failed', parsed.error.issues.map(i => i.message).join(', '));
      return NextResponse.json({ error: 'Invalid search parameters', details: parsed.error.issues }, { status: 400 });
    }

    const sanitize = (s: string | undefined, maxLen = 200) => {
      if (!s) return s;
      if (s.length > maxLen) return s.slice(0, maxLen);
      if (/(.)\1{10,}/.test(s)) return s.slice(0, 50);
      return s;
    };

    const {
      query: rawQuery, location: rawLocation, minPrice, maxPrice, propertyType, bhkType, listingPurpose,
      amenities = [], furnishings = [], bathrooms, minArea, maxArea, lat, lng, radiusKm, bounds,
      polygon, polygons, state, cursor, pageSize = 24, sort = 'newest', scope = 'properties',
    } = parsed.data as any;

    // Admin-1 state selection resolves server-side to the same canonical
    // MapTiler geometry the map outline renders; it supersedes any raw boundary
    // the client sent.
    let effectivePolygon = polygon as any;
    let effectivePolygons = polygons as any;
    let regionShapes: { outer: { lat: number; lng: number }[]; holes: { lat: number; lng: number }[][] }[] | undefined;
    let regionToken: string | undefined;
    if (typeof state === 'string' && state.trim()) {
      const meta = getAdminRegionLite(state.trim());
      if (!meta) {
        return NextResponse.json({ error: `unknown state: ${state}` }, { status: 400 });
      }
      const region = getAdminRegion(state.trim());
      if (!region) {
        return NextResponse.json({ error: 'state geometry unavailable' }, { status: 503 });
      }
      regionShapes = region.shapes;
      regionToken = region.token;
      effectivePolygon = undefined;
      effectivePolygons = undefined;
    }

    const stripNumbers = (s: string | undefined): string | undefined => {
      if (!s) return s;
      const t = s.replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
      return t.length > 0 ? t : undefined;
    };
    const query = stripNumbers(sanitize(rawQuery)?.toLowerCase().trim());
    const location = stripNumbers(sanitize(rawLocation)?.toLowerCase().trim());
    const normalizedAmenities = amenities.map((a: string) => a.toLowerCase().trim());
    const normalizedFurnishings = furnishings.map((f: string) => f.toLowerCase().trim());
    // Normalized once so the key, the query, and /api/map-data page 1 all
    // describe the identical boundary (fixes stale Load-More pages). State
    // selections arrive pre-normalized from the registry.
    const boundaryRings = normalizeBoundaryPolygons(effectivePolygon, effectivePolygons);
    const hasBoundary = boundaryRings.length > 0 || regionShapes !== undefined;

    // NOTE: cursor MUST be part of the key — without it every "load more"
    // page returns the cached page 1, which appends duplicate ids downstream.
    // A state boundary is keyed by its region token, never the multi-megabyte
    // canonical shapes.
    const cacheKey = `s:${JSON.stringify({ query, location, minPrice, maxPrice, propertyType, bhkType, listingPurpose, amenities: normalizedAmenities, furnishings: normalizedFurnishings, bathrooms, minArea, maxArea, lat, lng, radiusKm, bounds: roundBounds(bounds), polygons: boundaryRings.length > 0 ? boundaryRings : null, region: regionToken ?? null, pageSize, sort, scope, cursor: cursor ?? null })}`;

    const cached = await cacheGet(cacheKey);
    timing.record('cache');
    if (cached) {
      return attachTiming(NextResponse.json(cached), timing);
    }

    const esUp = await isEsAvailable();
    timing.record('ping');
    if (!esUp) {
      return NextResponse.json({ error: 'ES unavailable', message: 'Search engine temporarily down' }, { status: 503 });
    }

    const es = getElasticsearchClient();

    // AD3: the append path uses the SAME population builder as map-data page 1.
    // The previous inline copy had drifted (no entity_type scope constraint,
    // `price` instead of `low_price` for projects, minBedrooms ignored), so a
    // Load-More page could paginate a different population than page 1.
    const { must, filters } = buildFilters(
      {
        ...parsed.data,
        polygon: undefined,
        polygons: boundaryRings.length > 0 ? boundaryRings : undefined,
        polygonsWithHoles: regionShapes,
        regionToken,
      },
      scope
    );

    let sortClause: any[];
    if (scope === 'both') {
      if (sort === 'price_asc') {
        // P1: indexed missing:_last (filter-cache friendly), no painless script.
        sortClause = [
          { sort_price: { order: 'asc', missing: '_last' } },
          { _score: { order: 'desc' } },
        ];
      } else if (sort === 'price_desc') {
        sortClause = [
          { sort_price: { order: 'desc', missing: '_last' } },
          { _score: { order: 'desc' } },
        ];
      } else if (sort === 'newest') {
        sortClause = [{ created_at: { order: 'desc' } }];
      } else if (sort === 'popular') {
        sortClause = [{ _score: { order: 'desc' } }];
      } else {
        sortClause = [{ _score: { order: 'desc' } }];
      }
    } else {
      sortClause = [{ _score: { order: 'desc' } }, { created_at: { order: 'desc' } }];
      if (sort === 'price_asc') {
        sortClause = [
          { price: { order: 'asc', missing: '_last' } },
          { _score: { order: 'desc' } },
        ];
      }
      if (sort === 'price_desc') {
        sortClause = [
          { price: { order: 'desc', missing: '_last' } },
          { _score: { order: 'desc' } },
        ];
      }
      if (sort === 'newest') sortClause = [{ created_at: { order: 'desc' } }];
      if (sort === 'popular') sortClause = [{ property_score: { order: 'desc' } }, { _score: { order: 'desc' } }];
    }

    if (lat != null && lng != null) {
      sortClause.unshift({
        _geo_distance: {
          location: { lat, lon: lng },
          order: 'asc',
          unit: 'km',
          distance_type: 'plane',
        },
      });
    }

    const nativeCounts = flags.nativeCounts;
    const splitCounts = flags.splitCounts;
    const esQuery: any = {
      index: indexForScope(scope),
      size: pageSize,
      // Split (default): the list query never counts — exact totals come from
      // the cached size:0 count request below (2-3.5x faster at 1M; a top-k
      // collector otherwise counts every match). Inline fallbacks as before.
      track_total_hits: splitCounts ? false : (nativeCounts ? true : (flags.exactCountCounters ? false : 10000)),
      query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
      // Unique tiebreaker so search_after pagination can never return the
      // same doc on two pages (tied sorts otherwise overlap → duplicate keys).
      // Uses the keyword `id` field — _id sorting is disallowed in ES 8.
      sort: [...sortClause, { id: { order: 'asc' } }],
    };

    if (scope === 'both') {
      esQuery.aggs = {
        // Split: counts (incl. the split) come from the count request. Inline:
        // cheapest exact split (one ordinal pass); the counter fallback skips
        // it and derives the split from value_count siblings instead.
        ...(splitCounts ? {} : nativeCounts || !flags.exactCountCounters ? { by_entity_type: { terms: { field: 'entity_type', size: 2 } } } : {}),
      };
    } else {
      esQuery.aggs = {
        by_property_type: { terms: { field: 'property_type', size: 20 } },
        by_bhk: { terms: { field: 'bhk_type', size: 10 } },
        by_listing_purpose: { terms: { field: 'listing_purpose', size: 10 } },
        by_furnishing: { terms: { field: 'furnishing_status', size: 10 } },
        by_amenities: { terms: { field: 'amenities', size: 50 } },
        price_stats: { stats: { field: 'price' } },
      };
    }

    // Counter fallback only (SPLIT_COUNTS=0, NATIVE_COUNTS=0): exact totals via
    // filter→value_count siblings. Un-narrowed base filters on purpose
    // (quantile ranges must never feed the badge count).
    if (!splitCounts && !nativeCounts && flags.exactCountCounters) {
      const scoped = (extra: any) => ({
        filter: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter: [...filters, extra],
          },
        },
        aggs: { total: { value_count: { field: 'id' } } },
      });
      esQuery.aggs = {
        ...(esQuery.aggs || {}),
        exact_total: {
          filter: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter: filters } },
          aggs: { total: { value_count: { field: 'id' } } },
        },
        exact_property: scoped({ term: { entity_type: 'property' } }),
        exact_project: scoped({ term: { entity_type: 'project' } }),
      };
    }

    if (cursor) {
      esQuery.search_after = cursor;
    }

    const tCompute = performance.now();
    const [esResponse, counts] = await Promise.all([
      es.search(esQuery),
      splitCounts ? getListingCountsFor(must, filters, scope, sort, regionToken) : Promise.resolve(null),
    ]);
    timing.record('compute', performance.now() - tCompute);
    recordEsSuccess();
    const hits = esResponse.hits.hits;

    const results = hits.map((hit: any) => ({
      ...hit._source,
      _score: hit._score,
      _sort: hit.sort,
    }));

    let exactTotal: number;
    let exactRelation: string | undefined;
    let propertyTotal = 0;
    let projectTotal = 0;
    if (splitCounts && counts) {
      // Exact totals from the cached count request (relation 'eq' — uncapped).
      exactTotal = counts.total;
      exactRelation = counts.totalRelation;
      propertyTotal = counts.propertyTotal;
      projectTotal = counts.projectTotal;
    } else {
      const total = typeof esResponse.hits.total === 'object' ? esResponse.hits.total.value : esResponse.hits.total;
      const totalRelation = typeof esResponse.hits.total === 'object' ? (esResponse.hits.total as any).relation : undefined;

      // Exact badge totals from the counter siblings when present (always eq).
      // Falls back to the legacy capped/terms path when the flag is off.
      const xTotal: number | undefined = (esResponse as any).aggregations?.exact_total?.total?.value;
      const xProp: number | undefined = (esResponse as any).aggregations?.exact_property?.total?.value;
      const xProj: number | undefined = (esResponse as any).aggregations?.exact_project?.total?.value;
      const hasExact = typeof xTotal === 'number' && typeof xProp === 'number' && typeof xProj === 'number';
      exactTotal = hasExact ? (xTotal as number) : typeof total === 'number' ? total : 0;
      exactRelation = hasExact ? 'eq' : totalRelation;

      if (scope === 'both') {
        if (typeof xProp === 'number' && typeof xProj === 'number') {
          propertyTotal = xProp;
          projectTotal = xProj;
        } else {
          const entityAgg = (esResponse as any).aggregations?.by_entity_type?.buckets || [];
          for (const bucket of entityAgg) {
            if (bucket.key === 'property') propertyTotal = bucket.doc_count;
            if (bucket.key === 'project') projectTotal = bucket.doc_count;
          }
        }
      } else if (scope === 'projects') {
        projectTotal = exactTotal;
      } else {
        propertyTotal = exactTotal;
      }
    }

    // Intent-aware empty state (mirrors esQueryBuilder.queryESListings): one
    // cheap count without the purpose filter, only when total is 0, riding the
    // same cached/coalesced count path.
    let withoutPurposeTotal: number | null = null;
    if (exactTotal === 0 && typeof listingPurpose === 'string' && listingPurpose.trim()) {
      try {
        const relaxed = buildFilters({ ...parsed.data, listingPurpose: undefined, polygonsWithHoles: regionShapes, regionToken }, scope);
        const relaxedCounts = await getListingCountsFor(relaxed.must, relaxed.filters, scope, sort, regionToken);
        withoutPurposeTotal = typeof relaxedCounts?.total === 'number' ? relaxedCounts.total : null;
      } catch {
        withoutPurposeTotal = null;
      }
    }

    const response: any = {
      results,
      total: exactTotal,
      totalRelation: exactRelation,
      nextCursor: hits.length === pageSize && hits.length > 0 ? hits[hits.length - 1].sort : null,
      aggregations: { facets: (esResponse as any).aggregations || {} },
      withoutPurposeTotal,
    };

    if (scope === 'both') {
      response.propertyTotal = propertyTotal;
      response.projectTotal = projectTotal;
    }

    const tCacheWrite = performance.now();
    await cacheSet(cacheKey, response, 60);
    timing.record('cacheWrite', performance.now() - tCacheWrite);

    logger.searchAnalytics(query || location || '', response.total, 0);

    // Analytics is fire-and-forget; in dev it creates a Supabase client +
    // Redis writes that compete for the event loop. Skip in dev.
    if (process.env.NODE_ENV === 'production') {
      enqueueAnalytics({
        query_text: query || location || '',
        total_results: response.total,
        latency_ms: 0,
        filters: {
          minPrice, maxPrice, propertyType, bhkType, listingPurpose,
          amenities, furnishings, bathrooms, minArea, maxArea,
          lat, lng, radiusKm,
        },
      }).catch(() => {});
    }

    const tSerialize = performance.now();
    const res = NextResponse.json(response);
    timing.record('serialize', performance.now() - tSerialize);
    return attachTiming(res, timing);
  } catch (error: any) {
    logger.error('Search API error', error.message);
    recordEsFailure();
    return NextResponse.json({ error: 'Search failed', message: error.message }, { status: 500 });
  }
}
