// In-process merge/dedupe/clip/stride microbenchmark (the app-side half of the
// marker path). The ES tile fan-out returns ≤8 tiles × ≤1000 cells each; this
// measures what assembling the final ≤500 markers costs in the Node process.
//
// Usage: npx tsx scripts/bench-merge.ts
import { mergeTileMarkers, dedupeMarkers, clipToViewport, strideToCap } from '@/lib/tileMerge';

const BOUNDS = { minLat: 28.3, maxLat: 28.8, minLng: 76.9, maxLng: 77.5 };
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function makeTiles(tiles: number, cellsPerTile: number, dupFraction: number) {
  const seenIds: string[] = [];
  const tileResults: any[] = [];
  for (let t = 0; t < tiles; t++) {
    const markers: any[] = [];
    for (let c = 0; c < cellsPerTile; c++) {
      const dup = seenIds.length > 0 && rnd() < dupFraction ? seenIds[Math.floor(rnd() * seenIds.length)] : null;
      const id = dup ?? `p${t}_${c}`;
      if (!dup) seenIds.push(id);
      markers.push({
        id,
        entity_type: rnd() < 0.9 ? 'property' : 'project',
        lat: BOUNDS.minLat + rnd() * (BOUNDS.maxLat - BOUNDS.minLat),
        lon: BOUNDS.minLng + rnd() * (BOUNDS.maxLng - BOUNDS.minLng),
        price: Math.round(rnd() * 50_000_000),
        _createdMs: Date.now() - Math.round(rnd() * 1e10),
        _cellKey: `cell_${t}_${c}`,
        _cellCount: 1 + Math.floor(rnd() * 500),
        bhk_type: `${1 + Math.floor(rnd() * 5)} BHK`,
        bathrooms: 1 + Math.floor(rnd() * 4),
        area_sqft: 400 + Math.round(rnd() * 3000),
      });
    }
    tileResults.push({ markers });
  }
  return tileResults;
}

function timeIt(name: string, fn: () => unknown, iters = 300) {
  fn(); // warmup
  const t0 = performance.now();
  let sink: any;
  for (let i = 0; i < iters; i++) sink = fn();
  const per = (performance.now() - t0) / iters;
  console.log(`  ${name.padEnd(46)} ${per.toFixed(3)} ms/op  (sink=${(sink as any)?.length ?? 0})`);
  return per;
}

console.log('# merge microbench (Node, in-process)');
for (const [tiles, cells, dup] of [[8, 1000, 0.02], [8, 1000, 0.5], [8, 100, 0.02], [1, 1000, 0.02]] as const) {
  const data = makeTiles(tiles, cells, dup);
  const total = tiles * cells;
  console.log(`\n## tiles=${tiles} cells=${cells} total=${total} dupFraction=${dup}`);
  const all = data.flatMap((t) => t.markers);
  timeIt('dedupeMarkers', () => dedupeMarkers(all));
  const deduped = dedupeMarkers(all);
  timeIt('clipToViewport', () => clipToViewport(deduped, BOUNDS));
  const clipped = clipToViewport(deduped, BOUNDS);
  timeIt('strideToCap(500, newest)', () => strideToCap(clipped, 500, 'newest'));
  timeIt('mergeTileMarkers(full path, newest)', () => mergeTileMarkers(data, BOUNDS, 'newest', 500));
  timeIt('mergeTileMarkers(full path, price_desc)', () => mergeTileMarkers(data, BOUNDS, 'price_desc', 500));
}
