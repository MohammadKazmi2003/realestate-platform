import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkAutocompleteRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';
import { mergeSuggestions } from '@/lib/suggestions';
import { scoreGeoCandidate, queryTokensOf } from '@/lib/geoRank';

interface AutocompleteSuggestion {
  type: 'location' | 'property' | 'project' | 'geocoded';
  text: string;
  entity: string;
  /** Stable MapTiler feature id — the client fetches exact geometry by id on
   * select (one call), so the clicked entity can never mismatch the outline. */
  id?: string;
  /** MapTiler place types (e.g. ['place'], ['subregion']) — lets the client
   * prefer administrative entities with real boundaries. */
  place_type?: string[];
  /** Heuristic: non-degenerate bbox ≈ a real boundary exists (city `place`
   * entries often collapse to a point and have no polygon to outline). */
  hasBoundary?: boolean;
  bbox?: number[];
  center?: number[];
  polygons?: { lat: number; lng: number }[][];
}

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY || '';

async function getESResults(q: string, indices: string[], signal?: AbortSignal): Promise<AutocompleteSuggestion[]> {
  const es = getElasticsearchClient();
  const response = await es.search({
    index: indices,
    size: 8,
    _source: ['location_text', 'title', 'name', 'entity_type'],
    query: {
      bool: {
        should: [
          // Edge-ngram subfield: order-insensitive prefix matching so small
          // localities match from any token ("DN Nagar", "Old Panvel").
          { match: { 'location_text.autocomplete': { query: q, boost: 3 } } },
          { match_phrase_prefix: { location_text: { query: q, boost: 2 } } },
          { match_phrase_prefix: { title: { query: q, boost: 2 } } },
          { match_phrase_prefix: { name: { query: q, boost: 2 } } },
        ],
      },
    },
  }, {
    requestTimeout: 2000,
    maxRetries: 0,
    signal,
  });

  const suggestions: AutocompleteSuggestion[] = [];
  const seen = new Set<string>();

  for (const hit of response.hits.hits) {
    const src = hit._source as any;
    const entity = src.entity_type || 'property';

    if (src.location_text && !seen.has(`loc:${src.location_text}`)) {
      seen.add(`loc:${src.location_text}`);
      suggestions.push({ type: 'location', text: src.location_text, entity });
    }

    const name = src.title || src.name;
    if (name && !seen.has(`name:${name}`)) {
      seen.add(`name:${name}`);
      const type = entity === 'project' ? 'project' : 'property';
      suggestions.push({ type, text: name, entity });
    }
  }

  return suggestions;
}

async function getGeoResults(q: string, country?: string, proximity?: string): Promise<AutocompleteSuggestion[]> {
  if (!MAPTILER_KEY) return [];
  try {
    // Geometry is resolved by feature id on select (exact entity, one call),
    // so suggestions stay light: id + bbox + center only, no polygons here.
    const countryParam = country ? `&country=${encodeURIComponent(country)}` : '';
    // proximity=lng,lat biases toward the visible map without hard-filtering
    // far matches (validated lng/lat ranges; ignored when malformed).
    let proximityParam = '';
    const m = (proximity || '').match(/^(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)$/);
    if (m) {
      const lng = Number(m[1]);
      const lat = Number(m[3]);
      if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 85) {
        proximityParam = `&proximity=${lng},${lat}`;
      }
    }
    const geoUrl = `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?key=${MAPTILER_KEY}&limit=5&language=en${countryParam}${proximityParam}`;
    const geoResponse = await fetch(geoUrl, { signal: AbortSignal.timeout(3000) });
    if (!geoResponse.ok) return [];
    const geoData = await geoResponse.json();

    const features = (geoData.features || []).slice(0, 5);
    const queryTokens = queryTokensOf(q);
    const ranked = features
      .map((feature: any, i: number) => ({ feature, score: scoreGeoCandidate(feature, queryTokens), i }))
      .sort((a, b) => b.score - a.score || a.i - b.i);
    const suggestions: AutocompleteSuggestion[] = [];

    for (const { feature } of ranked) {
      const placeName = feature.place_name || '';
      if (placeName) {
        const bbox: number[] | undefined = feature.bbox;
        suggestions.push({
          type: 'geocoded',
          text: placeName,
          entity: 'location',
          id: feature.id,
          bbox,
          center: feature.center,
          place_type: Array.isArray(feature.place_type) ? feature.place_type : undefined,
          hasBoundary: !!bbox && bbox.length === 4 && bbox[0] !== bbox[2] && bbox[1] !== bbox[3],
        });
      }
    }

    return suggestions;
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const identifier = getRateLimitIdentifier(req);
  const { allowed } = await checkAutocompleteRateLimit(identifier);
  if (!allowed) {
    return NextResponse.json({ suggestions: [], error: 'Too many requests' }, { status: 429 });
  }

  const q = req.nextUrl.searchParams.get('q') || '';
  if (q.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const scope = req.nextUrl.searchParams.get('scope') || 'both';
  const country = (req.nextUrl.searchParams.get('country') || '').trim().slice(0, 32);
  const proximity = (req.nextUrl.searchParams.get('proximity') || '').trim().slice(0, 48);

  let indices: string[];
  if (scope === 'properties') {
    indices = [ES_INDEX_ALIAS];
  } else if (scope === 'projects') {
    indices = [PROJECTS_INDEX_ALIAS];
  } else {
    indices = [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS];
  }

  // Proximity rounded to ~1km in the key: nearby viewports share entries
  // instead of each pixel producing a unique cache key.
  const proximityKey = (() => {
    const m = proximity.match(/^(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)$/);
    if (!m) return '';
    return `${Number(m[1]).toFixed(2)},${Number(m[3]).toFixed(2)}`;
  })();
  const cacheKey = `ac:${scope}:${country.toLowerCase()}:${proximityKey}:${q.toLowerCase().trim()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    // Run ES and MapTiler in parallel.
    // Real timeout: geocoding gets max 2500ms; ES is fast. Both must complete
    // (or geo times out) before we respond — geo is NEVER silently dropped.
    const esPromise = getESResults(q, indices, req.signal);
    const geoPromise = Promise.race([
      getGeoResults(q, country || undefined, proximity || undefined),
      new Promise<AutocompleteSuggestion[]>(res => setTimeout(() => res([]), 2500)),
    ]);

    // Handle each source independently: if ES fails, keep geo results (and vice-versa).
    // A .catch on Promise.all would discard BOTH on a single failure → empty suggestions.
    const [esSuggestions, geoSuggestions] = await Promise.all([
      esPromise.catch(() => [] as AutocompleteSuggestion[]),
      geoPromise.catch(() => [] as AutocompleteSuggestion[]),
    ]);

    // Interleave: first geocoded (for map context), then ES matches.
    // mergeSuggestions is bounded by construction — see src/lib/suggestions.ts.
    const interleaved = mergeSuggestions<AutocompleteSuggestion>(esSuggestions, geoSuggestions, 8);

    const result = { suggestions: interleaved };
    // A2: Never cache empty results — prevents poisoning the cache for 120s
    if (interleaved.length > 0) {
      await cacheSet(cacheKey, result, 30);
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Autocomplete error:', error.message);
    return NextResponse.json({ suggestions: [], error: error.message }, { status: 500 });
  }
}
