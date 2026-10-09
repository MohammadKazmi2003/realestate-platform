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
      withPercentiles: true,
    });
    expect(q.aggs.p90).toBeUndefined();
    expect(q.size).toBe(0);
    expect(q.track_total_hits).toBe(false);
  });

  it('singleflight wait window outlives the lock TTL', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'redis.ts'), 'utf8');
    const lockMatch = src.match(/lockTtlMs\s*\?\?\s*(\d+)/);
    const waitMatch = src.match(/waitMs\s*\?\?\s*(\d+)/);
    expect(lockMatch).not.toBeNull();
    expect(waitMatch).not.toBeNull();
    const lockTtlMs = Number(lockMatch![1]);
    const waitMs = Number(waitMatch![1]);
    expect(waitMs).toBeGreaterThan(lockTtlMs);
  });
});
