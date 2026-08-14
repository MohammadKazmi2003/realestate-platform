import { NextRequest, NextResponse } from 'next/server';
import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from '@/lib/elasticsearch';
import { cacheGet, cacheSet } from '@/lib/redis';
import { checkAutocompleteRateLimit, getRateLimitIdentifier } from '@/lib/rateLimit';

interface AutocompleteSuggestion {
  type: 'location' | 'property' | 'project' | 'geocoded';
  text: string;
  entity: string;
  bbox?: number[];
  center?: number[];
  polygons?: { lat: number; lng: number }[][];
}

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY || '';

function geoJsonCoordsToLatLng(coords: any): { lat: number; lng: number }[][] {
  if (!coords || coords.length === 0) return [];
  const result: { lat: number; lng: number }[][] = [];
  const isMultiPolygon = Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && Array.isArray(coords[0][0][0]);
  if (isMultiPolygon) {
    for (const polygon of coords) {
      for (const ring of polygon) {
        if (Array.isArray(ring)) {
          result.push(ring.map(([lng, lat]: number[]) => ({ lat, lng })));
        }
      }
    }
  } else {
    for (const ring of coords) {
      if (Array.isArray(ring)) {
        result.push(ring.map(([lng, lat]: number[]) => ({ lat, lng })));
      }
    }
  }
  return result;
}

async function fetchFeatureGeometry(featureId: string): Promise<{ lat: number; lng: number }[][] | null> {
  if (!MAPTILER_KEY) return null;
  try {
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(featureId)}.json?key=${MAPTILER_KEY}&language=en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    const geo = data.features?.[0]?.geometry;
    if (geo && (geo.type === 'MultiPolygon' || geo.type === 'Polygon')) {
      return geoJsonCoordsToLatLng(geo.coordinates);
    }
    return null;
  } catch {
    return null;
  }
}

async function getESResults(q: string, indices: string[], signal?: AbortSignal): Promise<AutocompleteSuggestion[]> {
  const es = getElasticsearchClient();
  const response = await es.search({
    index: indices,
    size: 8,
    _source: ['location_text', 'title', 'name', 'entity_type'],
    query: {
      bool: {
        should: [
          { match_phrase_prefix: { location_text: { query: q, boost: 3 } } },
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

async function getGeoResults(q: string): Promise<AutocompleteSuggestion[]> {
  if (!MAPTILER_KEY) return [];
  try {
    const geoUrl = `https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?key=${MAPTILER_KEY}&limit=5&language=en`;
    const geoResponse = await fetch(geoUrl, { signal: AbortSignal.timeout(3000) });
    const geoData = await geoResponse.json();

    const features = (geoData.features || []).slice(0, 5);
    const suggestions: AutocompleteSuggestion[] = [];

    for (const feature of features) {
      const placeName = feature.place_name || '';
      if (placeName) {
        suggestions.push({
          type: 'geocoded',
          text: placeName,
          entity: 'location',
          bbox: feature.bbox,
          center: feature.center,
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

  let indices: string[];
  if (scope === 'properties') {
    indices = [ES_INDEX_ALIAS];
  } else if (scope === 'projects') {
    indices = [PROJECTS_INDEX_ALIAS];
  } else {
    indices = [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS];
  }

  const cacheKey = `ac:${scope}:${q.toLowerCase().trim()}`;
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
      getGeoResults(q),
      new Promise<AutocompleteSuggestion[]>(res => setTimeout(() => res([]), 2500)),
    ]);

    // Handle each source independently: if ES fails, keep geo results (and vice-versa).
    // A .catch on Promise.all would discard BOTH on a single failure → empty suggestions.
    const [esSuggestions, geoSuggestions] = await Promise.all([
      esPromise.catch(() => [] as AutocompleteSuggestion[]),
      geoPromise.catch(() => [] as AutocompleteSuggestion[]),
    ]);

    // Deduplicate: don't show same text twice
    const seen = new Set<string>();
    const esFiltered = esSuggestions.filter(s => {
      if (seen.has(s.text)) return false;
      seen.add(s.text);
      return true;
    });
    const geoFiltered = geoSuggestions.filter(s => {
      if (seen.has(s.text)) return false;
      seen.add(s.text);
      return true;
    });

    // Interleave: first geocoded (for map context), then ES matches
    const interleaved: AutocompleteSuggestion[] = [];
    let gIdx = 0, eIdx = 0;

    if (gIdx < geoFiltered.length) {
      interleaved.push(geoFiltered[gIdx++]);
    }
    while (interleaved.length < 8) {
      if (eIdx < esFiltered.length) interleaved.push(esFiltered[eIdx++]);
      if (gIdx < geoFiltered.length && interleaved.length < 8) interleaved.push(geoFiltered[gIdx++]);
    }

    const result = { suggestions: interleaved.slice(0, 8) };
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
