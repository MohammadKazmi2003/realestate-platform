import { NextRequest, NextResponse } from 'next/server';
import { isEsAvailable } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import { prepareMapQuery } from '@/lib/filterNormalize';
import { redisTTLForSort, cdnSMaxAgeForSort } from '@/lib/mapTiles';

// Lazy pills: standalone by_project terms agg (size:0, no hits).
// The list path skips by_project (flags.lazyPills) to save ~15-20% CPU at
// 10M docs; clients fetch this separately with skeleton UI. Own long-TTL
// cache key so adding Redis/ES infra scales pills independently.
async function serveGroups(searchParams: URLSearchParams) {
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
    scope: get('scope') || 'both',
    sort: get('sort') || 'newest',
  };
  const { bounds: b, filters } = prepareMapQuery(bounds, rawFilters);
  const sortStr = String(rawFilters.sort || 'newest');
  const key = `pg:v1:${b.minLat.toFixed(4)}/${b.maxLat.toFixed(4)}/${b.minLng.toFixed(4)}/${b.maxLng.toFixed(4)}:${JSON.stringify(filters)}`;
  const cached = await cacheGet<any>(key);
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        'Cache-Control': `public, s-maxage=${cdnSMaxAgeForSort(sortStr)}, stale-while-revalidate=60`,
        'X-Cache': 'HIT',
      },
    });
  }
  const esUp = await isEsAvailable();
  if (!esUp) return NextResponse.json({ error: 'Search unavailable', projectGroups: [] }, { status: 503 });
  const { queryESProjectGroups } = await import('@/lib/esQueryBuilder');
  const groups = await queryESProjectGroups({ ...filters, bounds: b }, String(rawFilters.scope || 'both')).catch(
    (e) => {
      logger.warn('project-groups failed', e);
      return null;
    }
  );
  if (!groups) return NextResponse.json({ error: 'Search unavailable', projectGroups: [] }, { status: 503 });
  const payload = { projectGroups: groups };
  await cacheSet(key, payload, Math.max(redisTTLForSort(sortStr), 300));
  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': `public, s-maxage=${cdnSMaxAgeForSort(sortStr)}, stale-while-revalidate=60`,
      'X-Cache': 'MISS',
    },
  });
}

export async function GET(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkMapRateLimit(identifier);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  return serveGroups(req.nextUrl.searchParams);
}

export async function POST(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkMapRateLimit(identifier);
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
    return serveGroups(sp);
  } catch (e: any) {
    logger.error('project-groups error', e?.message || e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
