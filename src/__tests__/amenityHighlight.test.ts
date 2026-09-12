import { highlightAmenities } from '@/lib/amenityHighlight';

describe('highlightAmenities', () => {
  it('puts premium amenities first in config order', () => {
    const out = highlightAmenities(['Lift', 'Swimming Pool', 'Power Backup', 'Gym', 'Parking']);
    expect(out[0]).toBe('Swimming Pool');
    expect(out).toHaveLength(3);
  });

  it('fills remainder from original order and caps output', () => {
    const out = highlightAmenities(['Lift', 'Parking', 'Power Backup', 'Garden']);
    expect(out).toEqual(['Lift', 'Parking', 'Power Backup']);
  });

  it('matches case-insensitively and skips blanks', () => {
    const out = highlightAmenities(['lift', '', 'SWIMMING POOL', null, undefined, 'Parking']);
    expect(out[0]).toBe('SWIMMING POOL');
    expect(out).toHaveLength(3);
  });

  it('returns first-N when nothing matches premium', () => {
    const out = highlightAmenities(['Lift', 'Parking']);
    expect(out).toEqual(['Lift', 'Parking']);
  });

  it('handles empty input', () => {
    expect(highlightAmenities([])).toEqual([]);
    expect(highlightAmenities(null)).toEqual([]);
  });
});
