import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import { tenant } from '@/lib/tenant';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

// Serves the tenant admin-1 boundary assets gzipped:
//   /api/admin-geo            → OVERVIEW (simplified, always-on outline layer)
//   /api/admin-geo?state=ID   → CANONICAL MapTiler geometry for one
//                               state/emirate (verbatim, holes + islands
//                               included). The client draws hover/selection
//                               with exactly the shape the server filters by.
//
// Next serves files under public/ uncompressed; the overview alone is ~2.9 MB
// raw (~1.2 MB gzipped) and a canonical file can be larger, so both are
// gzipped once per process and cached in memory. The assets are static per
// deploy and cache-busted client-side with `?v=<sha>` from the manifest (the
// query param is ignored here), so every subsequent visitor is served from the
// CDN/browser cache.
const cache = new Map<string, Buffer>();

function gzipped(relPath: string): Buffer | null {
  const hit = cache.get(relPath);
  if (hit) return hit;
  try {
    const raw = readFileSync(path.join(process.cwd(), 'public', relPath));
    const buf = gzipSync(raw, { level: 6 });
    cache.set(relPath, buf);
    return buf;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkMapRateLimit(identifier);
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const state = (req.nextUrl.searchParams.get('state') || '').trim();
  let rel: string;
  if (state) {
    // Strict id shape: prevents path traversal and unknown ids alike.
    if (!/^(IN|AE)-[A-Z]{2}$/.test(state)) {
      return NextResponse.json({ error: 'invalid state id' }, { status: 400 });
    }
    rel = `geo/regions/${state}.geojson`;
  } else {
    const file = tenant.map.admin1?.file;
    if (!file) return NextResponse.json({ error: 'admin geometry unavailable' }, { status: 404 });
    rel = file;
  }

  const buf = gzipped(rel);
  if (!buf) return NextResponse.json({ error: 'admin geometry unavailable' }, { status: 404 });

  return new Response(buf, {
    headers: {
      'Content-Type': 'application/geo+json',
      'Content-Encoding': 'gzip',
      'Content-Length': String(buf.length),
      // Detail is immutable per deploy; the overview is too, but keep a shorter
      // browser TTL so a stale outline ages out within a day.
      'Cache-Control': state
        ? 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400'
        : 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
      Vary: 'Accept-Encoding',
    },
  });
}
