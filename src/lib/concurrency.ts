// Bounded per-request fan-out: a single viewport fans into N tile queries and
// uncapped Promise.all would hold N ES connections at once, starving the pool
// exactly when traffic is highest. The worker pool caps in-flight work while
// preserving result order (out[i] aligns with items[i]).
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 1, items.length));
  const workers = Array.from(
    { length: n },
    async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return out;
}
