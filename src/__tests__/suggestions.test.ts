import { mergeSuggestions } from '@/lib/suggestions';

const t = (text: string) => ({ text });

// Guard: run each case inside a timeout so a merge regression fails the
// suite instead of hanging the runner (the original bug wedged prod).
async function completes<T>(fn: () => T, ms = 1000): Promise<T> {
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('merge did not terminate')), ms)),
  ]);
}

describe('mergeSuggestions', () => {
  it('returns [] for empty inputs (previous infinite-loop case)', async () => {
    await expect(completes(() => mergeSuggestions([], []))).resolves.toEqual([]);
  });

  it('returns short lists untouched when combined < limit', async () => {
    const out = await completes(() => mergeSuggestions([t('a'), t('b')], [t('c')]));
    expect(out.map((s) => s.text)).toEqual(['c', 'a', 'b']);
  });

  it('caps at the limit with geo-first interleaving', async () => {
    const es = Array.from({ length: 8 }, (_, i) => t(`e${i}`));
    const geo = Array.from({ length: 8 }, (_, i) => t(`g${i}`));
    const out = await completes(() => mergeSuggestions(es, geo, 8));
    expect(out).toHaveLength(8);
    expect(out[0].text).toBe('g0');
    expect(out[1].text).toBe('e0');
  });

  it('dedupes by exact text across sources', async () => {
    const out = await completes(() => mergeSuggestions([t('x'), t('y')], [t('x'), t('z')]));
    expect(out.map((s) => s.text)).toEqual(['z', 'x', 'y']);
  });
});
