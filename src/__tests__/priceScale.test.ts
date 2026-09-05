import {
  buildNoUiRange,
  getPriceScale,
  parsePriceInput,
  posToValue,
  snapDown,
  snapUp,
  stepForValue,
  valueToPos,
  TRACK_SIZE,
} from '@/lib/priceScale';

describe('priceScale — configurable adaptive buckets', () => {
  it('INR sale tiers match spec (5L <1Cr, 10L 1-5Cr, 25L 5-10Cr, 50L 10-20Cr)', () => {
    const s = getPriceScale('INR', 'sale');
    expect(stepForValue(s, 5_000_000)).toBe(500_000);
    expect(stepForValue(s, 10_000_000)).toBe(500_000);
    expect(stepForValue(s, 10_000_001)).toBe(1_000_000);
    expect(stepForValue(s, 50_000_000)).toBe(1_000_000);
    expect(stepForValue(s, 75_000_000)).toBe(2_500_000);
    expect(stepForValue(s, 150_000_000)).toBe(5_000_000);
    expect(s.max).toBe(200_000_000);
  });

  it('rent and sale scales differ per currency', () => {
    const sale = getPriceScale('INR', 'sale');
    const rent = getPriceScale('INR', 'rent');
    expect(rent.max).toBeLessThan(sale.max);
    expect(stepForValue(rent, 30_000)).toBe(1_000);
  });

  it('unknown currency falls back instead of throwing', () => {
    const s = getPriceScale('XYZ', 'sale');
    expect(s.tiers.length).toBeGreaterThan(0);
    expect(s.max).toBeGreaterThan(0);
  });

  it('tier-relative snap widens correctly', () => {
    const s = getPriceScale('INR', 'sale');
    // 1.23Cr floors to 1.2Cr (10L grid relative to 1Cr boundary), not 5L grid.
    expect(snapDown(s, 12_300_000)).toBe(12_000_000);
    expect(snapUp(s, 12_300_000)).toBe(13_000_000);
    // Sub-1Cr uses 5L grid.
    expect(snapDown(s, 9_840_000)).toBe(9_500_000);
    expect(snapUp(s, 9_840_000)).toBe(10_000_000);
  });

  it('value<->pos round-trips through tier boundaries without jumps', () => {
    const s = getPriceScale('INR', 'sale');
    expect(valueToPos(s, s.min)).toBe(0);
    expect(valueToPos(s, s.max)).toBe(TRACK_SIZE);
    // Monotonic across the 1Cr boundary.
    const below = valueToPos(s, 9_500_000);
    const at = valueToPos(s, 10_000_000);
    const above = valueToPos(s, 11_000_000);
    expect(below).toBeLessThan(at);
    expect(at).toBeLessThan(above);
    // Round-trip within half a tier step.
    for (const v of [500_000, 9_500_000, 10_000_000, 30_000_000, 75_000_000, 150_000_000]) {
      const back = posToValue(s, valueToPos(s, v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(stepForValue(s, v));
    }
  });

  it('builds a noUiSlider-compatible non-linear range', () => {
    const s = getPriceScale('INR', 'sale');
    const r = buildNoUiRange(s);
    expect(r['0%'][0]).toBe(s.min);
    expect(r['100%'][0]).toBe(s.max);
    // 4 tiers -> 5 breakpoints.
    expect(Object.keys(r)).toHaveLength(5);
  });

  it('parses Indian shorthand + grouped digits', () => {
    expect(parsePriceInput('1.5cr')).toBe(15_000_000);
    expect(parsePriceInput('50L')).toBe(5_000_000);
    expect(parsePriceInput('₹ 1,00,000')).toBe(100_000);
    expect(parsePriceInput('500000')).toBe(500_000);
    expect(parsePriceInput('25k')).toBe(25_000);
    expect(parsePriceInput('')).toBeUndefined();
    expect(parsePriceInput('abc')).toBeUndefined();
  });
});
