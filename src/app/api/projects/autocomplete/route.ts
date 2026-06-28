import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, isEsAvailable, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { checkSearchRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

export async function GET(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkSearchRateLimit(identifier);
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const q = req.nextUrl.searchParams.get('q') || '';
  if (!q || q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const esUp = await isEsAvailable();
  if (!esUp) {
    return NextResponse.json({ suggestions: [] });
  }

  const es = getElasticsearchClient();

  const esQuery = {
    index: PROJECTS_INDEX_ALIAS,
    suggest: {
      project_suggest: {
        prefix: q,
        completion: {
          field: 'suggest',
          size: 8,
          fuzzy: { fuzziness: 2 },
        },
      },
    },
    _source: ['id', 'name', 'slug', 'image_url', 'low_price', 'high_price'],
    size: 0,
  };

  const response = await es.search(esQuery);
  const suggestions = (response as any).suggest?.project_suggest?.[0]?.options || [];

  return NextResponse.json({
    suggestions: suggestions.map((opt: any) => ({
      text: opt.text,
      ...opt._source,
    })),
  });
}
