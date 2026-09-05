import { prepareMapQuery, normalizeFilters } from '@/lib/filterNormalize';

const B = { minLat: 24.9, maxLat: 25.3, minLng: 55.0, maxLng: 55.5 };
const BASE = { scope: 'both' as const, sort: 'relevance' as const };

describe('filterNormalize — cache-key architecture invariants', () => {
  it('same view + same filters produce identical keys (stable cache)', () => {
    const a = prepareMapQuery(B, BASE);
    const b = prepareMapQuery({ ...B }, { ...BASE });
    expect(a.markerKey).toBe(b.markerKey);
    expect(a.listKey).toBe(b.listKey);
  });

  it('different viewports produce different keys (no cross-viewport reuse)', () => {
    const a = prepareMapQuery(B, BASE);
    // Adjacent pan: shifted 0.2° east.
    const panned = prepareMapQuery({ ...B, minLng: 55.2, maxLng: 55.7 }, BASE);
    expect(panned.markerKey).not.toBe(a.markerKey);
    expect(panned.listKey).not.toBe(a.listKey);
  });

  it('sort/page changes keep the marker key but change the list key', () => {
    const a = prepareMapQuery(B, BASE);
    const sorted = prepareMapQuery(B, { ...BASE, sort: 'price_asc', pageSize: 24, cursor: ['x'] as any });
    // Markers show physical pins — ordering/pagination must not refetch them.
    expect(sorted.markerKey).toBe(a.markerKey);
    expect(sorted.listKey).not.toBe(a.listKey);
  });

  it('array order does not change the key (Rule 1)', () => {
    const a = prepareMapQuery(B, { ...BASE, amenities: ['pool', 'gym'] });
    const b = prepareMapQuery(B, { ...BASE, amenities: ['gym', 'pool'] });
    expect(a.markerKey).toBe(b.markerKey);
    expect(a.listKey).toBe(b.listKey);
  });

  it('price buckets widen-only: cohorts share keys, exact intent preserved', () => {
    // scope=both uses the finest step (AED 50k): 98.4k and 75k both floor to 50k.
    const a = prepareMapQuery(B, { ...BASE, minPrice: 98400 });
    const b = prepareMapQuery(B, { ...BASE, minPrice: 75000 });
    expect(a.markerKey).toBe(b.markerKey);
    const n = normalizeFilters({ minPrice: 98400, maxPrice: 101000, scope: 'both' });
    // Floors go down, ceilings go up — the query can only ever widen.
    expect(n.minPrice).toBeLessThanOrEqual(98400);
    expect(n.maxPrice).toBeGreaterThanOrEqual(101000);
  });

  it('text is lowercased/trimmed before hashing (Rule 4)', () => {
    const a = prepareMapQuery(B, { ...BASE, query: '2BHK Near Metro!' });
    const b = prepareMapQuery(B, { ...BASE, query: ' 2bhk   near metro! ' });
    expect(a.markerKey).toBe(b.markerKey);
  });

  it('float dust does not fork keys for the same viewport', () => {
    const dusty = {
      minLat: 24.900000000000002,
      maxLat: 25.300000000000004,
      minLng: 54.99999999999999,
      maxLng: 55.50000000000001,
    };
    const a = prepareMapQuery(B, BASE);
    const b = prepareMapQuery(dusty, BASE);
    expect(a.markerKey).toBe(b.markerKey);
    expect(a.listKey).toBe(b.listKey);
  });

  it('polygon vertices are rounded and capped (no per-drag unique keys)', () => {
    const ring = Array.from({ length: 200 }, (_, i) => ({
      lat: 25 + Math.sin(i / 10) * 0.123456789,
      lng: 55 + Math.cos(i / 10) * 0.987654321,
    }));
    const a = prepareMapQuery(B, { ...BASE, polygon: ring });
    const b = prepareMapQuery(B, { ...BASE, polygon: [...ring].reverse() });
    // Reversed ring differs (shape order matters) but vertex count is capped.
    expect(a.filters.polygon!.length).toBeLessThanOrEqual(51); // 50 + closing point
    const tiny = ring.map((p) => ({ lat: p.lat + 1e-9, lng: p.lng + 1e-9 }));
    const c = prepareMapQuery(B, { ...BASE, polygon: tiny });
    expect(c.markerKey).toBe(a.markerKey);
  });

  it('bounds in the prepared query equal the requested viewport (coverage)', () => {
    const { bounds } = prepareMapQuery(B, BASE);
    expect(bounds.minLat).toBeLessThanOrEqual(B.minLat);
    expect(bounds.maxLat).toBeGreaterThanOrEqual(B.maxLat);
    expect(bounds.minLng).toBeLessThanOrEqual(B.minLng);
    expect(bounds.maxLng).toBeGreaterThanOrEqual(B.maxLng);
    // Exact: no grid expansion beyond float dust.
    expect(bounds.maxLat - bounds.minLat).toBeLessThan(B.maxLat - B.minLat + 1e-5);
  });
});
