// Append-only pagination guard: ES search_after without a unique sort can
// return the same doc on two pages (tied sort values, concurrent writes),
// and the infinite-scroll sentinel can double-fire a page. Merging by id
// keeps React keys unique no matter what the backend returns.

export function mergeUniqueById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (next.length === 0) return prev;
  if (prev.length === 0) return [...next];
  const seen = new Set<string>();
  for (const p of prev) seen.add(p.id);
  let dupes = false;
  const fresh: T[] = [];
  for (const n of next) {
    if (seen.has(n.id)) {
      dupes = true;
      continue;
    }
    seen.add(n.id);
    fresh.push(n);
  }
  return dupes ? [...prev, ...fresh] : [...prev, ...next];
}
