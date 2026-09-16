import { viewportCoveringTiles, precisionForZoom, tileToBounds, buildFilterHash64, redisTTLForSort } from '@/lib/mapTiles';
import { prepareTileQuery, sortBucketForKey } from '@/lib/filterNormalize';
import { dedupeMarkers, clipToViewport, strideToCap, mergeTileMarkers } from '@/lib/tileMerge';
import { fillMarkerDeficit } from '@/lib/esTileMarkers';
import { sortBucket } from '@/lib/flags';

const B = { minLat: 28.35, maxLat: 28.75, minLng: 76.85, maxLng: 77.35 };

describe('tile keys — additive, reversible', () => {
  it('covering tiles: small pans share tiles (reuse), exact keys do not', () => {
    const a = viewportCoveringTiles(B, 11);
    const b = viewportCoveringTiles({ ...B, minLng: B.minLng + 0.002, maxLng: B.maxLng + 0.002 }, 11);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(12);
    const sa = new Set(a.map((t) => `${t.z}/${t.x}/${t.y}`));
    const sb = new Set(b.map((t) => `${t.z}/${t.x}/${t.y}`));
    const overlap = [...sa].filter((k) => sb.has(k));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('tile query keys embed z/x/y + filterHash + sortHash (no exact bounds)', () => {
    const t = { z: 10, x: 1, y: 2 };
    const a = prepareTileQuery(t, { scope: 'both', sort: 'price_desc' });
    const b = prepareTileQuery(t, { scope: 'both', sort: 'newest' });
    expect(a.tileKey).toContain('md:v5:t:10/1/2:');
    expect(a.tileKey).not.toBe(b.tileKey);
    expect(a.sortHash).toBe('price_desc');
    expect(b.sortHash).toBe('newest');
  });

  it('sort bucket keeps ordering sorts distinct, collapses scored sorts (no key explosion)', () => {
    expect(sortBucket('popular')).toBe('default');
    expect(sortBucket('price_asc')).toBe('price_asc');
    expect(sortBucket('beds')).toBe('beds');
    expect(sortBucket('baths')).toBe('baths');
    expect(sortBucket('sqft')).toBe('sqft');
    expect(sortBucket('lot')).toBe('lot');
    expect(sortBucket('newest')).toBe('newest');
    expect(sortBucket('relevance')).toBe('default');
  });

  it('sortBucketForKey matches flags sortBucket (single key scheme)', () => {
    for (const s of ['price_asc', 'price_desc', 'newest', 'beds', 'baths', 'sqft', 'lot', 'popular', 'relevance', undefined]) {
      expect(sortBucketForKey(s)).toBe(sortBucket(s));
    }
  });

  it('new sorts get distinct tile keys (map shifts with sort)', () => {
    const t = { z: 10, x: 1, y: 2 };
    const keys = new Set(
      ['price_desc', 'beds', 'baths', 'sqft', 'lot'].map((sort) => prepareTileQuery(t, { scope: 'both', sort } as any).tileKey)
    );
    expect(keys.size).toBe(5);
  });

  it('precision table keeps cells bounded', () => {
    expect(precisionForZoom(4)).toBe(3);
    expect(precisionForZoom(11)).toBe(5);
    expect(precisionForZoom(15)).toBe(7);
  });

  it('tileToBounds round-trips covering tile', () => {
    const tb = tileToBounds(10, 1, 2);
    expect(tb.minLat).toBeLessThan(tb.maxLat);
    expect(tb.minLng).toBeLessThan(tb.maxLng);
  });

  it('64-bit hash stable', () => {
    expect(buildFilterHash64({ a: 1 })).toBe(buildFilterHash64({ a: 1 }));
  });

  it('tiered TTL: newest fresh, price stable', () => {
    expect(redisTTLForSort('newest')).toBe(60);
    expect(redisTTLForSort('price_desc')).toBe(300);
  });
});

describe('tileMerge — dedupe/clip/stride preserves contract', () => {
  const mk = (id: string, lat: number, lon: number, price = 1, type = 'property') => ({ id, entity_type: type, lat, lon, price });
  it('dedupes by type:id across tiles', () => {
    const out = dedupeMarkers([mk('a', 1, 1), mk('a', 1, 1), { ...mk('a', 1, 1), entity_type: 'project' } as any]);
    expect(out.length).toBe(2);
  });
  it('clips to exact viewport (no misplaced pins)', () => {
    const out = clipToViewport([mk('a', 28.5, 77.0), mk('b', 0, 0)], B);
    expect(out.map((m: any) => m.id)).toEqual(['a']);
  });
  it('stride caps to 500 deterministically', () => {
    const many = Array.from({ length: 1200 }, (_, i) => mk(`id-${i}`, 28.5, 77.0, i));
    const out = strideToCap(many as any, 500, 'price_desc');
    expect(out.length).toBe(500);
    expect((out[0] as any).price).toBe(1199);
  });
  it('merge tiles end-to-end', () => {
    const out = mergeTileMarkers([{ markers: [mk('a', 28.5, 77.0)] }, { markers: [mk('a', 28.5, 77.0), mk('b', 28.6, 77.1)] }], B, 'newest', 500);
    expect(out.map((m: any) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('merge preserves _cellCount density badges through dedupe/clip/stride', () => {
    const dense = { ...mk('a', 28.5, 77.0), _cellCount: 218 };
    const single = mk('b', 28.6, 77.1);
    const out = mergeTileMarkers([{ markers: [dense, single] }], B, 'newest', 500);
    const byId: any = Object.fromEntries(out.map((m: any) => [m.id, m]));
    expect(byId.a._cellCount).toBe(218);
    expect(byId.b._cellCount === undefined || byId.b._cellCount === 1).toBe(true);
    // Stride cap keeps dense cells represented (sorted by rank, deterministic).
    const many = Array.from({ length: 600 }, (_, i) => ({ ...mk(`id-${i}`, 28.5 + (i % 10) * 0.001, 77.0, 100 - i, ), _cellCount: i < 5 ? 50 : 1 }));
    const capped = mergeTileMarkers([{ markers: many }], { minLat: 28, maxLat: 29, minLng: 76.5, maxLng: 77.5 }, 'price_desc', 500);
    expect(capped.length).toBe(500);
  });

  it('stride orders beds/baths/sqft/lot sorts (documented fallbacks match)', () => {
    const mkBeds = (id: string, bhk: string) => ({ ...mk(id, 28.5, 77.0), bhk_type: bhk, bathrooms: 1, area_sqft: 100 });
    const out = strideToCap([mkBeds('a', '1 BHK'), mkBeds('b', '3 BHK'), mkBeds('c', '2 BHK')] as any, 2, 'beds');
    expect(out.map((m: any) => m.id)).toEqual(['b', 'c']);
    const mkArea = (id: string, area: number) => ({ ...mk(id, 28.5, 77.0), area_sqft: area });
    const outSqft = strideToCap([mkArea('a', 500), mkArea('b', 1500)] as any, 1, 'sqft');
    expect(outSqft.map((m: any) => m.id)).toEqual(['b']);
    const outLot = strideToCap([mkArea('a', 500), mkArea('b', 1500)] as any, 1, 'lot');
    expect(outLot.map((m: any) => m.id)).toEqual(['b']);
  });

  it('fillMarkerDeficit tops up toward target without dupes or overflow', () => {
    const tile = [{ ...mk('a', 28.5, 77.0), _cellCount: 100 }];
    const fill = [mk('a', 28.5, 77.0), mk('b', 28.51, 77.01), mk('c', 28.52, 77.02)];
    // tileDocTotal 300, have 1 -> want 299, fill has 2 fresh -> 3 total.
    expect(fillMarkerDeficit(tile as any, fill as any, 300, 500).map((m: any) => m.id)).toEqual(['a', 'b', 'c']);
    // Never exceeds target even with abundant fill.
    const bigFill = Array.from({ length: 600 }, (_, i) => mk(`f-${i}`, 28.5, 77.0));
    expect(fillMarkerDeficit(tile as any, bigFill as any, 2000, 500).length).toBe(500);
    // No-op when tiles already cover target or total is small.
    expect(fillMarkerDeficit(tile as any, fill as any, 1, 500).length).toBe(1);
    expect(fillMarkerDeficit(tile as any, [] as any, 2000, 500).length).toBe(1);
  });
});
