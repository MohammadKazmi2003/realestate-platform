import { mapEsResultToPropertyCard } from '@/lib/searchClient';

describe('mapEsResultToPropertyCard — full gallery passthrough', () => {
  const base = {
    id: 'p1',
    title: 'Test Villa',
    location_text: 'Dubai',
    price: 100000,
    area_sqft: 2000,
    area_unit: 'sqft',
    owner_phone: null,
    user_id: 'u1',
    property_type: 'Residential',
    bhk_type: '3 BHK',
    bedrooms: 3,
    bathrooms: 2,
    balconies: 1,
    cabins: null,
    workstations: null,
    min_seats: null,
    max_seats: null,
    furnishing_status: null,
    listing_purpose: 'sell',
    location: { lat: 25.2, lon: 55.3 },
  };

  it('preserves all 20 images with image_url first (no cap)', () => {
    const all = Array.from({ length: 19 }, (_, i) => `https://cdn.test/img${i}.jpg`);
    const esResult = { ...base, image_url: 'https://cdn.test/primary.jpg', all_images: all };
    const mapped = mapEsResultToPropertyCard(esResult);
    expect(mapped.images).toHaveLength(20);
    expect(mapped.images[0]).toEqual({ image_url: 'https://cdn.test/primary.jpg' });
    expect(mapped.image_url).toBe('https://cdn.test/primary.jpg');
  });

  it('dedupes image_url when it also appears in all_images', () => {
    const esResult = {
      ...base,
      image_url: 'https://cdn.test/a.jpg',
      all_images: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
    };
    const mapped = mapEsResultToPropertyCard(esResult);
    expect(mapped.images).toEqual([{ image_url: 'https://cdn.test/a.jpg' }, { image_url: 'https://cdn.test/b.jpg' }]);
  });

  it('falls back to all_images when image_url is missing', () => {
    const esResult = { ...base, image_url: null, all_images: ['https://cdn.test/a.jpg'] };
    const mapped = mapEsResultToPropertyCard(esResult);
    expect(mapped.images).toEqual([{ image_url: 'https://cdn.test/a.jpg' }]);
    expect(mapped.image_url).toBe('https://cdn.test/a.jpg');
  });

  it('returns an empty gallery (card shows placeholder) when no images exist', () => {
    const esResult = { ...base, image_url: null, all_images: [] };
    const mapped = mapEsResultToPropertyCard(esResult);
    expect(mapped.images).toEqual([]);
    expect(mapped.image_url).toBeNull();
  });
});
