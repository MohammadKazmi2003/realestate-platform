export interface RankedSuggestion {
  text: string;
  [key: string]: unknown;
}

/**
 * Merge ES + geocoded suggestions into one capped list, geocoded first (map
 * context), then alternating. Deduplicates by exact text.
 *
 * The loop is bounded by construction (an index always advances per
 * iteration) — a previous `while (out.length < limit)` version spun forever
 * when both inputs combined held fewer than `limit` items, wedging the
 * entire server event loop on a single keystroke.
 */
export function mergeSuggestions<T extends RankedSuggestion>(
  esSuggestions: T[],
  geoSuggestions: T[],
  limit = 8
): T[] {
  const seen = new Set<string>();
  const esFiltered = esSuggestions.filter((s) => {
    if (!s || typeof s.text !== 'string' || seen.has(s.text)) return false;
    seen.add(s.text);
    return true;
  });
  const geoFiltered = geoSuggestions.filter((s) => {
    if (!s || typeof s.text !== 'string' || seen.has(s.text)) return false;
    seen.add(s.text);
    return true;
  });

  const out: T[] = [];
  let gIdx = 0;
  let eIdx = 0;
  if (gIdx < geoFiltered.length) {
    out.push(geoFiltered[gIdx++]);
  }
  while (out.length < limit && (eIdx < esFiltered.length || gIdx < geoFiltered.length)) {
    if (eIdx < esFiltered.length) out.push(esFiltered[eIdx++]);
    if (out.length < limit && gIdx < geoFiltered.length) out.push(geoFiltered[gIdx++]);
  }
  return out.slice(0, limit);
}
