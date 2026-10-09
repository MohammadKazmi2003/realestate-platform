import * as fs from 'fs';
import * as path from 'path';
import { buildTileAggQuery } from '@/lib/esTileMarkers';

describe('tile scale baseline', () => {
  it('drops the dead p90 agg from tile queries', () => {
    const q: any = buildTileAggQuery({
      tileBounds: { minLat: 28, maxLat: 29, minLng: 77, maxLng: 78 },
      must: [],
      filters: [{ term: { status: 'available' } }],
      scope: 'both',
      sort: 'price_desc',
      zoom: 12,
    });
    expect(q.aggs.p90).toBeUndefined();
    expect(q.size).toBe(0);
    expect(q.track_total_hits).toBe(false);
  });

  it('singleflight wait window outlives the lock TTL (Invariant 6)', async () => {
    const { SINGLEFLIGHT_LOCK_TTL_MS, SINGLEFLIGHT_WAIT_MS } = await import('@/lib/redis');
    // Waiters must outlive the lock they wait on, otherwise they give up while
    // the winner is still working and every one of them recomputes — strictly
    // worse than having no lock at all.
    expect(SINGLEFLIGHT_WAIT_MS).toBeGreaterThan(SINGLEFLIGHT_LOCK_TTL_MS);
  });
});
