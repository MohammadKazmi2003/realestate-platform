// Ranking for geocoded autocomplete candidates. Dynamic mix by design:
// administrative areas win on name collisions (town over district/county),
// but water/roads/addresses are demoted — never dropped — so genuinely
// relevant small places still surface.

export const ADMIN_GEO_TYPES = new Set([
  'region',
  'subregion',
  'locality',
  'municipality',
  'neighborhood',
  'place',
]);

const DEMOTED_GEO_TYPES = new Set(['major_landform', 'water', 'road', 'address', 'poi']);

export interface GeoCandidate {
  place_name?: string | null;
  place_type?: string[] | null;
  bbox?: number[] | null;
}

export function scoreGeoCandidate(feature: GeoCandidate, queryTokens: string[]): number {
  const name = (feature.place_name || '').toLowerCase();
  const types: string[] = Array.isArray(feature.place_type) ? feature.place_type : [];
  let score = 0;
  // Name-token relevance outweighs type bonuses/demotions: a token-matching
  // lake must still beat a token-less admin row.
  for (const tok of queryTokens) {
    if (tok && name.includes(tok)) score += 4;
  }
  if (types.some((t) => ADMIN_GEO_TYPES.has(t))) score += 2;
  if (types.some((t) => DEMOTED_GEO_TYPES.has(t))) score -= 2;
  const bbox = feature.bbox;
  if (bbox && bbox.length === 4 && bbox[0] !== bbox[2] && bbox[1] !== bbox[3]) score += 1;
  return score;
}

export function queryTokensOf(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length >= 2);
}
