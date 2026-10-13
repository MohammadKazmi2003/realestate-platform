import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable } from '@/lib/elasticsearch';
import { cacheSet, singleflightCompute } from '@/lib/redis';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import { prepareMapQuery } from '@/lib/filterNormalize';
import { coveringTileUnionBounds } from '@/lib/mapTiles';

// Empty-pill TTL: long enough to protect the ES terms agg, short enough that a
// newly indexed project appears without waiting a full cache tier.
const EMPTY_PILLS_TTL = 30;
import { redisTTLForSort, cdnSMaxAgeForSort } from '@/lib/mapTiles';
import { attachTiming, makeServerTiming, ServerTiming } from '@/lib/routeTiming';
import { getAdminRegion, getAdminRegionLite } from '@/lib/adminRegionsServer';

// Lazy pills: standalone by_project terms agg (size:0, no hits).
// The list path skips by_project (flags.lazyPills) to save ~15-20% CPU at
// 10M docs; clients fetch this separately with skeleton UI. Own long-TTL
// cache key so adding Redis/ES infra scales pills independently.
async function serveGroups(searchParams: URLSearchParams, timing: ServerTiming) {
  const get = (k: string) => searchParams.get(k);
  const num = (k: string) => {
    const v = get(k);
    return v == null || v === '' ? undefined : Number(v);
  };
  const arr = (k: string) => {
    const v = get(k);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  };
  const bounds = {
    minLat: num('minLat') ?? NaN,
    maxLat: num('maxLat') ?? NaN,
    minLng: num('minLng') ?? NaN,
    maxLng: num('maxLng') ?? NaN,
  };
  if (![bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng].every(Number.isFinite)) {
    return NextResponse.json({ error: 'bounds (minLat,maxLat,minLng,maxLng) required' }, { status: 400 });
  }
  // Admin-1 state selection: pills must describe the SAME population as the
  // list/markers (AD3). The state id resolves to the canonical geometry
  // server-side; it supersedes any raw boundary params.
  const stateParam = get('state') || undefined;
  let regionShapes: { outer: { lat: number; lng: number }[]; holes: { lat: number; lng: number }[][] }[] | undefined;
  let regionToken: string | undefined;
  if (stateParam) {
    const meta = getAdminRegionLite(stateParam);
    if (!meta) {
      return NextResponse.json({ error: `unknown state: ${stateParam}` }, { status: 400 });
    }
    const region = getAdminRegion(stateParam);
    if (!region) {
      return NextResponse.json({ error: 'state geometry unavailable' }, { status: 503 });
    }
    regionShapes = region.shapes;
    regionToken = region.token;
  }
  const rawFilters: any = {
    query: get('query') || undefined,
    location: get('location') || undefined,
    minPrice: num('minPrice'),
    maxPrice: num('maxPrice'),
    propertyType: get('propertyType') || undefined,
    bhkType: get('bhkType') || undefined,
    listingPurpose: get('listingPurpose') || undefined,
    amenities: arr('amenities'),
    furnishings: arr('furnishings'),
    bathrooms: num('bathrooms'),
    minArea: num('minArea'),
    maxArea: num('maxArea'),
    polygon: undefined,
    polygonsWithHoles: regionShapes,
    regionToken,
    scope: get('scope') || 'both',
    sort: get('sort') || 'newest',
  };
  // AD1/AD4: the expensive full-match terms rollup is only worth isolating if
  // its key is SHAREABLE. Key on the covering-tile union (not 4dp exact bounds)
  // and reuse the list key's 64-bit filter hash, so pills and list describe the
  // same population for the same extent (AD3) and every pan in a tile set hits.
  const zoom = num('zoom') ?? 10;
  const union = coveringTileUnionBounds(
    {
      minLat: Math.max(-85.0511, Math.min(85.0511, bounds.minLat)),
      maxLat: Math.max(-85.0511, Math.min(85.0511, bounds.maxLat)),
      minLng: Math.max(-180, Math.min(180, bounds.minLng)),
      maxLng: Math.max(-180, Math.min(180, bounds.maxLng)),
    },
    zoom
  );
  const { bounds: b, filters, listKey } = prepareMapQuery(union, rawFilters);
  const sortStr = String(rawFilters.sort || 'newest');
  const key = listKey.replace('md:v5:l:', 'pg:v2:');
  const ttl = Math.max(redisTTLForSort(sortStr), 300);
  const esUp = await isEsAvailable();
  timing.record('ping');
  if (!esUp) return attachTiming(NextResponse.json({ error: 'Search unavailable', projectGroups: [] }, { status: 503 }), timing);
  // AD8/F8: coalesce across instances — a plain cacheGet/Set lets N pods each
  // run the full-population terms agg for the same new tile set.
  const tCompute = performance.now();
  const { value, status } = await singleflightCompute<{ projectGroups: any[] }>(
    key,
    ttl,
    async () => {
      const { queryESProjectGroups } = await import('@/lib/esQueryBuilder');
      const groups = await queryESProjectGroups({ ...filters, bounds: b }, String(rawFilters.scope || 'both')).catch((e) => {
        logger.warn('project-groups failed', e);
        return null;
      });
      if (!groups) return null; // query failed -> never cached (Invariant 4)
      if (groups.length === 0) {
        // A genuinely empty area is a valid answer, but an empty agg is also the
        // cheapest thing to re-ask, so cache it briefly rather than for the full
        // tier — a newly added project becomes visible quickly (Invariant 4).
        await cacheSet(key, { projectGroups: [] }, EMPTY_PILLS_TTL);
        return { projectGroups: [] };
      }
      await cacheSet(key, { projectGroups: groups }, ttl);
      return { projectGroups: groups };
    },
    { lockTtlMs: 8000, waitMs: 9000, skipCacheWrite: true }
  );
  timing.record('compute', performance.now() - tCompute);
  if (!value) return attachTiming(NextResponse.json({ error: 'Search unavailable', projectGroups: [] }, { status: 503 }), timing);
  const tSerialize = performance.now();
  const res = NextResponse.json(value, {
    headers: {
      'X-Cache': status === 'hit' ? 'HIT' : status === 'waited' ? 'WAIT' : 'MISS',
      'Cache-Control': `public, s-maxage=${cdnSMaxAgeForSort(sortStr)}, stale-while-revalidate=60`,
    },
  });
  timing.record('serialize', performance.now() - tSerialize);
  return attachTiming(res, timing);
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

export async function GET(req: NextRequest) {
  const timing = makeServerTiming();
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkMapRateLimit(identifier);
  timing.record('rl');
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  return edgeCacheable(await serveGroups(req.nextUrl.searchParams, timing));
}

export async function POST(req: NextRequest) {
  const timing = makeServerTiming();
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkMapRateLimit(identifier);
  timing.record('rl');
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  try {
    const body = await req.json();
    const { bounds, ...rest } = body;
    if (!bounds) return NextResponse.json({ error: 'bounds is required' }, { status: 400 });
    const sp = new URLSearchParams();
    sp.set('minLat', String(bounds.minLat));
    sp.set('maxLat', String(bounds.maxLat));
    sp.set('minLng', String(bounds.minLng));
    sp.set('maxLng', String(bounds.maxLng));
    for (const [k, v] of Object.entries(rest as Record<string, any>)) {
      if (v == null) continue;
      sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return serveGroups(sp, timing);
  } catch (e: any) {
    logger.error('project-groups error', e?.message || e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
