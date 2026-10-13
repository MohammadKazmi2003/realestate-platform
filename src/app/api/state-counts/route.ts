import { NextRequest, NextResponse } from 'next/server';
import { buildFilters, getListingCountsFor } from '@/lib/esQueryBuilder';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import { adminRegionsEnabled, getAdminRegion, getAdminRegionLite } from '@/lib/adminRegionsServer';
import { attachTiming, makeServerTiming, ServerTiming } from '@/lib/routeTiming';

// Lazy per-state hover counts (AD4): only the hovered/tapped state's count is
// computed, on the un-narrowed filter population (AD6 — quantile ranges must
// never feed counts), and cached under the shared population count key
// (md:v5:c:) via getListingCountsFor's Redis + cross-instance singleflight.
// The state id travels in the URL, so responses stay edge-cacheable.
async function serveCounts(searchParams: URLSearchParams, timing: ServerTiming) {
  const state = (searchParams.get('state') || '').trim();
  if (!state) {
    return NextResponse.json({ error: 'state is required' }, { status: 400 });
  }
  const meta = getAdminRegionLite(state);
  if (!meta) {
    return NextResponse.json({ error: `unknown state: ${state}` }, { status: 400 });
  }
  const region = getAdminRegion(state);
  if (!region) {
    return NextResponse.json({ error: 'state geometry unavailable' }, { status: 503 });
  }
  if (!adminRegionsEnabled()) {
    return NextResponse.json({ error: 'state selection disabled' }, { status: 404 });
  }

  const get = (k: string) => searchParams.get(k) || undefined;
  const num = (k: string) => {
    const v = searchParams.get(k);
    return v == null || v === '' ? undefined : Number(v);
  };
  const arr = (k: string) => {
    const v = searchParams.get(k);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  };
  const scope = get('scope') || 'both';

  // No bounds on purpose: the count describes the whole state, independent of
  // the current viewport. The server injects the canonical region geometry and
  // its token, so the count key never hashes the polygon.
  const { must, filters } = buildFilters(
    {
      query: get('query'),
      location: get('location'),
      minPrice: num('minPrice'),
      maxPrice: num('maxPrice'),
      propertyType: get('propertyType'),
      bhkType: get('bhkType'),
      listingPurpose: get('listingPurpose'),
      amenities: arr('amenities'),
      furnishings: arr('furnishings'),
      bathrooms: num('bathrooms'),
      minArea: num('minArea'),
      maxArea: num('maxArea'),
      polygon: undefined,
      polygonsWithHoles: region.shapes,
      regionToken: region.token,
    },
    scope
  );

  try {
    // 'popular' → 120 s TTL tier: long enough to absorb hub hover traffic,
    // short enough that a new listing becomes visible quickly.
    const counts = await getListingCountsFor(must, filters, scope, 'popular', region.token);
    if (!counts) {
      return attachTiming(NextResponse.json({ error: 'count unavailable' }, { status: 503 }), timing);
    }
    return attachTiming(
      NextResponse.json(
        {
          state: region.id,
          name: region.name,
          country: region.country,
          total: counts.total,
          totalRelation: counts.totalRelation,
          propertyTotal: counts.propertyTotal,
          projectTotal: counts.projectTotal,
        },
        { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' } }
      ),
      timing
    );
  } catch (e) {
    logger.warn('state-counts failed', e as Error);
    return NextResponse.json({ error: 'count unavailable' }, { status: 503 });
  }
}

// Same Vary normalization as map-data/project-groups so a stock CDN can share
// entries (Next stamps RSC negotiation headers an API JSON body never varies on).
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
  return edgeCacheable(await serveCounts(req.nextUrl.searchParams, timing));
}
