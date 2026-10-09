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

// --- AD1 / Invariant 1: tile-union keys,64-bit hashes, fill short-circuit ---
import { coveringTileUnionBounds } from '@/lib/mapTiles';
import { prepareMapQuery } from '@/lib/filterNormalize';
import { cellsAreUnclustered } from '@/lib/tileMerge';

describe('coveringTileUnionBounds — the shareable unit', () => {
  const B = { minLat: 28.40, maxLat: 28.45, minLng: 77.00, maxLng: 77.05 };

  it('pans inside one tile produce a byte-identical union (shared cache key)', () => {
    const a = coveringTileUnionBounds(B, 11);
    const b = coveringTileUnionBounds({ ...B, minLat: B.minLat + 0.001, maxLat: B.maxLat + 0.001 }, 11);
    expect(a).toEqual(b);
  });

  it('union is a superset of the viewport (AD5 — a hit can never hide a listing)', () => {
    const u = coveringTileUnionBounds(B, 11);
    expect(u.minLat).toBeLessThanOrEqual(B.minLat);
    expect(u.maxLat).toBeGreaterThanOrEqual(B.maxLat);
    expect(u.minLng).toBeLessThanOrEqual(B.minLng);
    expect(u.maxLng).toBeGreaterThanOrEqual(B.maxLng);
  });

  it('different zooms yield different unions (must not share)', () => {
    expect(coveringTileUnionBounds(B, 9)).not.toEqual(coveringTileUnionBounds(B, 12));
  });
});

describe('prepareMapQuery — 64-bit hash under md:v5', () => {
  it('keys are md:v5 and use a64-bit hash (collision-safe at traffic scale)', () => {
    const { markerKey, listKey } = prepareMapQuery(
      { minLat: 28.4, maxLat: 28.45, minLng: 77, maxLng: 77.05 },
      { scope: 'both', sort: 'newest' }
    );
    expect(markerKey.startsWith('md:v5:m:')).toBe(true);
    expect(listKey.startsWith('md:v5:l:')).toBe(true);
    //64-bit FNV returns base36 pairs of32-bit halves — longer than a32-bit hash.
    const mHash = markerKey.split(':')[3];
    expect(mHash!.length).toBeGreaterThan(6);
  });

  it('identical inputs produce identical keys (deterministic)', () => {
    const b = { minLat: 28.4, maxLat: 28.45, minLng: 77, maxLng: 77.05 };
    const f = { scope: 'both' as const, sort: 'newest' as const };
    expect(prepareMapQuery(b, f)).toEqual(prepareMapQuery(b, f));
  });

  it('changing sort changes the marker key (tiles are sort-ordered)', () => {
    const b = { minLat: 28.4, maxLat: 28.45, minLng: 77, maxLng: 77.05 };
    const a = prepareMapQuery(b, { sort: 'newest' });
    const c = prepareMapQuery(b, { sort: 'price_desc' });
    expect(a.markerKey).not.toBe(c.markerKey);
  });
});

describe('cellsAreUnclustered — Invariant 1 fill short-circuit', () => {
  it('unclustered (every cell count 1) means reps are the exact population', () => {
    expect(
      cellsAreUnclustered([
        { key: 'a', count: 1 },
        { key: 'b', count: 1 },
      ])
    ).toBe(true);
  });

  it('any clustered cell means fill is still required', () => {
    expect(
      cellsAreUnclustered([
        { key: 'a', count: 1 },
        { key: 'b', count: 4 },
      ])
    ).toBe(false);
  });

  it('empty/missing cells never short-circuit (would skip a needed fill)', () => {
    expect(cellsAreUnclustered([])).toBe(false);
    expect(cellsAreUnclustered(null)).toBe(false);
    expect(cellsAreUnclustered(undefined)).toBe(false);
  });
});

describe('covering tiles always cover the viewport (AD5)', () => {
  const spans = (u: { minLat: number; maxLat: number; minLng: number; maxLng: number }, b: typeof WORLD_B) =>
    u.minLat <= b.minLat && u.maxLat >= b.maxLat && u.minLng <= b.minLng && u.maxLng >= b.maxLng;

  const WORLD_B = { minLat: -60, maxLat: 70, minLng: -170, maxLng: 170 };

  it('world viewport at low zoom: union is a superset (regression: stride broke this)', () => {
    // Striding to the tile cap used to return only a row of tiles, so the union
    // covered the north strip while the user asked for the world — a cache hit
    // could then hide every listing outside that strip.
    expect(spans(coveringTileUnionBounds(WORLD_B, 4), WORLD_B)).toBe(true);
  });

  it('world viewport stays bounded (fan-out must not blow up either)', () => {
    const tiles = viewportCoveringTiles(WORLD_B, 4);
    expect(tiles.length).toBeLessThanOrEqual(8);
    expect(tiles.length).toBeGreaterThan(0);
  });

  it.each([[4], [6], [9], [11], [14]])('zoom %i: union spans the viewport', (z) => {
    const b = { minLat: 18.9, maxLat: 19.3, minLng: 72.8, maxLng: 73.1 };
    expect(spans(coveringTileUnionBounds(b, z), b)).toBe(true);
  });
});

// Regression: TDigest returns floats; a date field mapped epoch_millis rejects
// them outright, which made the newest-sort narrowing fail the whole tile agg.
describe('quantile range snaps to the field type', () => {
  it('created_at range is an integer (epoch_millis rejects floats)', async () => {
    const { quantileRangeForSort } = await import('@/lib/quantiles');
    const r = quantileRangeForSort({ p90: 1781130111610.6, updatedAt: '', version: 'v2' }, 'newest', 'both');
    expect(r).toEqual({ range: { created_at: { gte: 1781130111611 } } });
    expect(Number.isInteger(r.range.created_at.gte)).toBe(true);
  });

  it('integer sort fields snap too', async () => {
    const { quantileRangeForSort } = await import('@/lib/quantiles');
    const r = quantileRangeForSort({ p90: 3.7, updatedAt: '', version: 'v2' }, 'beds', 'properties');
    expect(Number.isInteger(r.range.bedrooms.gte)).toBe(true);
  });

  it('scaled_float price keeps full precision', async () => {
    const { quantileRangeForSort } = await import('@/lib/quantiles');
    const r = quantileRangeForSort({ p90: 12345678.91, updatedAt: '', version: 'v2' }, 'price_desc', 'both');
    expect(r.range.sort_price.gte).toBe(12345678.91);
  });
});

// Objective 3: markers carry only what identifies/positions them + preview.
describe('marker payload hygiene', () => {
  it('strips server-only keys, keeps the client-facing density badge', async () => {
    const { stripInternalMarkerFields } = await import('@/lib/tileMerge');
    const out = stripInternalMarkerFields([
      { id: 'a', _createdMs: 1700000000000, _cellKey: '10/1/2', _cellCount: 7, price: 1 },
    ] as any);
    expect(out[0]).not.toHaveProperty('_createdMs');
    expect(out[0]).not.toHaveProperty('_cellKey');
    expect((out[0] as any)._cellCount).toBe(7); // heat colour + badges need it
    expect((out[0] as any).price).toBe(1);
  });

  it('tolerates null/undefined (never throws on an empty path)', async () => {
    const { stripInternalMarkerFields } = await import('@/lib/tileMerge');
    expect(stripInternalMarkerFields(null as any)).toBeNull();
    expect(stripInternalMarkerFields(undefined as any)).toBeUndefined();
  });

  it('newest stride ranks by _createdMs, not by id (regression)', async () => {
    const { strideToCap } = await import('@/lib/tileMerge');
    // Mapped markers historically carried neither `created_at` nor a rank key,
    // so every sort value was equal and the tiebreak fell through to id order.
    // cap must be < length or strideToCap short-circuits before ranking.
    const markers = [
      { id: 'a', _createdMs: 100 },
      { id: 'b', _createdMs: 900 },
      { id: 'c', _createdMs: 500 },
    ];
    const out = strideToCap(markers as any, 2, 'newest');
    // Ranked newest-first then stride-sampled: b (900) then c (500).
    // Id-order would have yielded a first.
    expect(out.map((m: any) => m.id)).toEqual(['b', 'c']);
  });

  it('tile and legacy mappers emit the same internal rank key', () => {
    const esq = require('fs').readFileSync('src/lib/esQueryBuilder.ts', 'utf8');
    const tile = require('fs').readFileSync('src/lib/esTileMarkers.ts', 'utf8');
    expect(esq).toContain('_createdMs:');
    expect(tile).toContain('_createdMs:');
    // neither mapper should still emit the fields the frontend never reads
    for (const src of [esq, tile]) {
      const block = src.match(/MARKER_SOURCE_FIELDS = \[|TILE_TOP_METRICS_FIELDS = \[/);
      expect(block).not.toBeNull();
    }
    expect(esq).not.toMatch(/project_name: src\.project_name/);
    expect(tile).not.toMatch(/project_name: \(m as any\)\.project_name/);
  });
});
