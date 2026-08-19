import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { checkMapRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

// Lightweight single-listing lookup used when a sidebar card is hovered but its
// marker isn't among the ~500 loaded map dots. An ES GET by _id (sub-ms) is the
// cheapest possible lookup — no query parsing, no scoring, no aggregations.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id || id.length > 100) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const identifier = getRateLimitIdentifier(req);
    const { allowed } = await checkMapRateLimit(identifier);
    if (!allowed) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
    }

    const cacheKey = `l:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'public, s-maxage=300' },
      });
    }

    if (!(await isEsAvailable())) {
      return NextResponse.json(
        { error: 'Search services temporarily unavailable' },
        { status: 503 }
      );
    }

    // _id === doc.id in both indices (scripts/es-indexer.js, es-project-indexer.js).
    // Probe both aliases in parallel; either may hold the listing.
    const es = getElasticsearchClient();
    const [prop, proj] = await Promise.all([
      es.get({ index: ES_INDEX_ALIAS, id }).catch(() => null),
      es.get({ index: PROJECTS_INDEX_ALIAS, id }).catch(() => null),
    ]);
    const hit = prop?.found ? prop : proj?.found ? proj : null;
    if (!hit) {
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    }

    const src = hit._source as any;
    const result = {
      id: src.id ?? id,
      entity_type: src.entity_type,
      lat: src.location?.lat ?? null,
      lon: src.location?.lon ?? null,
      title: src.title || src.name || '',
      price: src.entity_type === 'project' ? (src.low_price || 0) : (src.sort_price || src.price || 0),
      image_url: src.image_url || src.primary_image || null,
      location_text: src.location_text || null,
    };

    await cacheSet(cacheKey, result, 300);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=300' },
    });
  } catch (error: any) {
    logger.error('Listing by-id API error', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
