import { tenant } from './tenant';

// Distinctive-amenity highlights for map click cards: premium/config-ordered
// names first, remainder in original (index) order, capped at maxShown.
// Pure function over the names already on hand — zero extra queries, works
// identically on cached cards. Unknown names fall through to original order,
// so config drift degrades gracefully to today's first-N behavior.
export function highlightAmenities(names: (string | null | undefined)[] | null | undefined): string[] {
  const clean = (names || []).filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  const cfg = tenant.amenitiesHighlight;
  const maxShown = cfg && Number.isFinite(cfg.maxShown) && cfg.maxShown > 0 ? Math.floor(cfg.maxShown) : 3;
  const premium = Array.isArray(cfg?.premium) ? cfg!.premium.filter((p) => typeof p === 'string') : [];
  if (premium.length === 0) return clean.slice(0, maxShown);

  const rank = new Map<string, number>();
  premium.forEach((p, i) => {
    const key = p.trim().toLowerCase();
    if (key && !rank.has(key)) rank.set(key, i);
  });

  const used = new Set<number>();
  const ordered: string[] = [];
  // Premium matches first, in config order (stable for equal ranks).
  const premiumHits = clean
    .map((name, idx) => ({ name, idx, rank: rank.get(name.trim().toLowerCase()) ?? Infinity }))
    .filter((h) => h.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank);
  for (const h of premiumHits) {
    if (ordered.length >= maxShown) break;
    used.add(h.idx);
    ordered.push(h.name);
  }
  for (let i = 0; i < clean.length && ordered.length < maxShown; i++) {
    if (!used.has(i)) ordered.push(clean[i]);
  }
  return ordered;
}
