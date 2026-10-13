import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { singleflightCompute } from '@/lib/redis';
import { checkPlaceGeoRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { logger } from '@/lib/logger';
import { selectPlacePolygon } from '@/lib/placeGeometry';

// Locality polygon resolver for locations MapTiler's geocoder only knows as
// centroids (city/neighborhood `place` entities). Source is OSM via Nominatim,
// which exposes real polygons with `polygon_geojson=1` — e.g. Dubai Marina
// relation 11912728, Dubai Investment Park neighbourhood way 874795301.
//
// Nominatim usage policy requires <= 1 request/second from an application, a
// custom User-Agent, and caching. Only cache misses reach upstream: results
// live in Redis for 30 days (OSM geometry is stable) and concurrent misses
// coalesce through singleflightCompute. Empty results and errors are never
// cached (Invariant 4) — callers fall back to recenter-only behavior.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'realestate-platform/1.0 (locality boundary resolver)';
const UPSTREAM_MIN_INTERVAL_MS = 1100;

// Serializes upstream calls with a true 1 req/s floor. The chain never rejects
// (each link is caught) so one failed lookup cannot wedge later ones.
let upstreamChain: Promise<unknown> = Promise.resolve();
let lastUpstreamCall = 0;
function pacedUpstream<T>(fn: () => Promise<T>): Promise<T> {
  const run = upstreamChain.then(async () => {
    const wait = Math.max(0, UPSTREAM_MIN_INTERVAL_MS - (Date.now() - lastUpstreamCall));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastUpstreamCall = Date.now();
    return fn();
  });
  upstreamChain = run.catch(() => undefined);
  return run;
}

export async function GET(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkPlaceGeoRateLimit(identifier);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const lat = Number(req.nextUrl.searchParams.get('lat'));
  const lng = Number(req.nextUrl.searchParams.get('lng'));
  if (
    q.length < 2 || q.length > 160 ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 85 || Math.abs(lng) > 180
  ) {
    return NextResponse.json({ error: 'q, lat, lng required' }, { status: 400 });
  }

  // Center rounded to ~100 m: nearby map viewports share one entry instead of
  // minting a unique upstream lookup per pan.
  const digest = createHash('sha1')
    .update(`${q.toLowerCase()}|${lat.toFixed(3)}|${lng.toFixed(3)}`)
    .digest('hex')
    .slice(0, 32);
  const cacheKey = `pg:osm:v1:${digest}`;

  try {
    const { value, status } = await singleflightCompute(
      cacheKey,
      CACHE_TTL_SECONDS,
      async () => {
        const url = `${NOMINATIM_URL}?format=jsonv2&polygon_geojson=1&limit=10&addressdetails=0&q=${encodeURIComponent(q)}`;
        let res: Response;
        try {
          res = await pacedUpstream(() =>
            fetch(url, {
              headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
              signal: AbortSignal.timeout(5000),
            })
          );
        } catch (e) {
          logger.warn('place-geometry upstream failed', e as Error);
          return null;
        }
        if (!res.ok) {
          logger.warn('place-geometry upstream status', new Error(String(res.status)));
          return null;
        }
        const json = await res.json().catch(() => null);
        const picked = selectPlacePolygon(json, { lat, lng });
        if (!picked) return null;
        return {
          ...picked,
          source: 'osm',
          attribution: '© OpenStreetMap contributors',
        };
      }
    );

    if (!value) {
      // No validated polygon. Not cached server-side (a locality may gain a
      // polygon later), but a short browser/CDN TTL keeps repeat searches for
      // the same no-boundary locality from re-querying Nominatim (their usage
      // policy requires caching).
      return NextResponse.json(
        { error: 'no boundary available' },
        { status: 404, headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=300' } }
      );
    }
    return NextResponse.json(value, {
      headers: {
        'X-Cache': status === 'hit' ? 'HIT' : status === 'waited' ? 'WAIT' : 'MISS',
        'Cache-Control': 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400',
      },
    });
  } catch (e) {
    logger.warn('place-geometry failed', e as Error);
    return NextResponse.json({ error: 'boundary lookup unavailable' }, { status: 503 });
  }
}
