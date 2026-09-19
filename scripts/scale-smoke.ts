// Scale-ready smoke: verifies bounded fan-out + infra-add-ready defaults.
// Run: npx tsx scripts/scale-smoke.ts
import { precisionForZoom, maxPrecisionForZoom, viewportCoveringTiles, routingForBounds } from '../src/lib/mapTiles';
import { buildTileAggQuery } from '../src/lib/esTileMarkers';
import { flags } from '../src/lib/flags';
import * as fs from 'fs';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// 1. Precision table unchanged (contract), cap overlays it.
check('precisionForZoom(4)==3', precisionForZoom(4) === 3);
check('precisionForZoom(11)==5', precisionForZoom(11) === 5);
check('precisionForZoom(15)==7', precisionForZoom(15) === 7);
check('maxPrecisionForZoom(8)<=6', maxPrecisionForZoom(8) <= 6, `got ${maxPrecisionForZoom(8)}`);
check('maxPrecisionForZoom(14)==12', maxPrecisionForZoom(14) === 12, `got ${maxPrecisionForZoom(14)}`);

// 2. Covering tiles bounded default ≤8 (was 12).
const B = { minLat: 28.3, maxLat: 28.7, minLng: 76.9, maxLng: 77.3 };
const tiles = viewportCoveringTiles(B, 11);
check('viewportCoveringTiles default ≤8', tiles.length <= 8, `got ${tiles.length}`);
const world = { minLat: -60, maxLat: 60, minLng: -170, maxLng: 170 };
const wt = viewportCoveringTiles(world, 5);
check('world viewport still bounded ≤8', wt.length <= 8, `got ${wt.length}`);

// 3. Tile agg: shard_size 1500, precision capped at low zoom.
const q = buildTileAggQuery({
  tileBounds: B,
  must: [],
  filters: [{ term: { status: 'available' } }],
  scope: 'both',
  sort: 'newest',
  zoom: 8,
});
check('shard_size==1500', q.aggs.tiles.geotile_grid.shard_size === 1500, `got ${q.aggs.tiles.geotile_grid.shard_size}`);
check('low-zoom precision capped ≤6', q.aggs.tiles.geotile_grid.precision <= 6, `got ${q.aggs.tiles.geotile_grid.precision}`);
check('size==1000 size:0 track off', q.size === 0 && q.track_total_hits === false && q.aggs.tiles.geotile_grid.size === 1000);

// 4. Flags: bounded fan-out defaults.
check('tileMaxAttempts==2', flags.tileMaxAttempts === 2, `got ${flags.tileMaxAttempts}`);
check('tileShardSize==1500', flags.tileShardSize === 1500, `got ${flags.tileShardSize}`);
check('lazyPills on', flags.lazyPills === true);
check('geoRouting on', flags.geoRouting === true);
check('distSingleflight on', flags.distSingleflight === true);
check('tileMaxTiles ≤8', flags.tileMaxTiles <= 8, `got ${flags.tileMaxTiles}`);

// 5. Routing: small viewport → 1 region, world → scatter [].
const r1 = routingForBounds(B);
check('routing small viewport 1 region', r1.length === 1, `got ${JSON.stringify(r1)}`);
const r2 = routingForBounds(world);
check('routing world → scatter', r2.length === 0);

// 6. Lazy pills: list agg skips by_project, standalone fn exists.
async function main() {
const { queryESProjectGroups } = await import('../src/lib/esQueryBuilder');
check('queryESProjectGroups exists', typeof queryESProjectGroups === 'function');

// 7. Routes: GET map-tiles (CDN) + project-groups exist.
const mt = fs.readFileSync('src/app/api/map-tiles/route.ts', 'utf-8');
check('map-tiles GET export', /export async function GET/.test(mt));
check('map-tiles bounded concurrency', /TILE_CONCURRENCY|mapWithConcurrency/.test(mt));
check('map-tiles distributed singleflight', /singleflightCompute/.test(mt));
const pg = fs.readFileSync('src/app/api/project-groups/route.ts', 'utf-8');
check('project-groups route', /queryESProjectGroups/.test(pg) && /s-maxage/.test(pg));

// 8. Infra-ready: ES multi-node, Redis cluster, volatile-lru.
const es = fs.readFileSync('src/lib/elasticsearch.ts', 'utf-8');
check('ES ELASTICSEARCH_URLS pool', /ELASTICSEARCH_URLS/.test(es));
const rd = fs.readFileSync('src/lib/redis.ts', 'utf-8');
check('Redis Cluster + singleflightCompute', /Cluster/.test(rd) && /singleflightCompute/.test(rd));
const dc = fs.readFileSync('docker-compose.yml', 'utf-8');
check('redis volatile-lru', /volatile-lru/.test(dc));

// 9. Fan-out math: worst cold pan before 99 → after ≤ ~35.
const before = 12 * 2 * 4 + 3;
const after = flags.tileMaxTiles * 2 * flags.tileMaxAttempts + 3;
check('worst fan-out reduced ≥50%', after <= before / 2, `${before} → ${after}`);
console.log(`\nFan-out: worst cold pan ${before} → ${after} ES searches (scope=both, cold).`);

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nAll scale-ready smoke checks passed.');
}

main().catch((e) => {
  console.error('smoke crashed', e);
  process.exit(1);
});
