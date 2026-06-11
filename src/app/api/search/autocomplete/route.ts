import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, ES_INDEX_ALIAS } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkSearchRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

export async function GET(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkSearchRateLimit(identifier);
  if (!allowed) {
    return NextResponse.json({ suggestions: [], error: 'Too many requests' }, { status: 429 });
  }

  const q = req.nextUrl.searchParams.get('q') || '';
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const cacheKey = `ac:${q.toLowerCase().trim()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const es = getElasticsearchClient();

    const response: any = await es.search({
      index: ES_INDEX_ALIAS,
      size: 0,
      suggest: {
        location_suggest: {
          prefix: q,
          completion: {
            field: 'suggest',
            size: 8,
            skip_duplicates: true,
          },
        },
        title_suggest: {
          prefix: q,
          completion: {
            field: 'suggest',
            size: 5,
            skip_duplicates: true,
          },
        },
      },
    });

    const locationSuggestions = (
      (response.suggest?.location_suggest?.[0]?.options || []) as any[]
    ).map((opt: any) => opt._source?.location_text || opt.text);

    const titleSuggestions = (
      (response.suggest?.title_suggest?.[0]?.options || []) as any[]
    ).map((opt: any) => ({ text: opt._source?.title || opt.text, type: opt._source?.property_type }));

    const allSuggestions = [...locationSuggestions, ...titleSuggestions.map((s: any) => s.text)];
    const unique = Array.from(new Set(allSuggestions));

    const result = { suggestions: unique, detailed: titleSuggestions };
    await cacheSet(cacheKey, result, 120);

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Autocomplete error:', error);
    return NextResponse.json({ suggestions: [], error: error.message }, { status: 500 });
  }
}
