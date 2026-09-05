import { formatMoneyCompact } from '@/lib/format';

describe('formatMoneyCompact — INR precision', () => {
  it('shows 57500000 as ₹5.75Cr, not ₹5.8Cr', () => {
    expect(formatMoneyCompact(57500000, 'INR')).toBe('₹5.75Cr');
  });

  it('trims trailing zeros (digits is max decimals)', () => {
    expect(formatMoneyCompact(58000000, 'INR')).toBe('₹5.8Cr');
    expect(formatMoneyCompact(15000000, 'INR')).toBe('₹1.5Cr');
    expect(formatMoneyCompact(10000000, 'INR')).toBe('₹1Cr');
    expect(formatMoneyCompact(5500000, 'INR')).toBe('₹55L');
  });

  it('keeps one fractional L instead of rounding to whole lakhs', () => {
    expect(formatMoneyCompact(5750000, 'INR')).toBe('₹57.5L');
  });
});
