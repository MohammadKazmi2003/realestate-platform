import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, ES_INDEX_ALIAS } from '@/lib/elasticsearch';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
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

    return NextResponse.json({
      suggestions: unique,
      detailed: titleSuggestions,
    });
  } catch (error: any) {
    console.error('Autocomplete error:', error);
    return NextResponse.json({ suggestions: [], error: error.message }, { status: 500 });
  }
}
