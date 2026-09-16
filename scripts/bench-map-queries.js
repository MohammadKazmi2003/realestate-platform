#!/usr/bin/env node
/**
 * P0 bench: 200 pans across Delhi/India zooms 5/11/14, records took/payload/hit%.
 * Usage: node scripts/bench-map-queries.js [baseUrl]
 * Traceable, read-only (POST map-data only, no writes).
 */
const BASE = process.argv[2] || 'http://localhost:3000';

const VIEWPORTS = [
  { name: 'delhi-z11', bounds: { minLat: 28.35, maxLat: 28.75, minLng: 76.85, maxLng: 77.35 }, zoom: 11 },
  { name: 'india-z5', bounds: { minLat: 8, maxLat: 35, minLng: 68, maxLng: 97 }, zoom: 5 },
  { name: 'street-z14', bounds: { minLat: 28.55, maxLat: 28.62, minLng: 77.15, maxLng: 77.25 }, zoom: 14 },
];
const SORTS = ['newest', 'price_asc', 'price_desc', 'popular'];

async function timed(body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/map-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, scope: 'both', pageSize: 24 }),
  });
  const ms = Date.now() - t0;
  const cache = res.headers.get('x-cache') || '';
  const took = res.headers.get('x-es-took') || '';
  const json = await res.json().catch(() => ({}));
  const bytes = JSON.stringify(json).length;
  return { ok: res.ok, status: res.status, ms, cache, took, total: json.total, markers: (json.markers || []).length, bytes };
}

async function main() {
  console.log(`\nBench map queries vs ${BASE} (200 pans)...`);
  const rows = [];
  let i = 0;
  for (const v of VIEWPORTS) {
    for (const sort of SORTS) {
      for (let k = 0; k < 16 && i < 200; k++, i++) {
        // Dust-shift bounds to simulate pan (≈0.001°).
        const j = k * 0.001;
        const r = await timed({ bounds: { minLat: v.bounds.minLat + j, maxLat: v.bounds.maxLat + j, minLng: v.bounds.minLng + j, maxLng: v.bounds.maxLng + j }, zoom: v.zoom, sort });
        rows.push({ viewport: v.name, sort, ...r });
        process.stdout.write('.');
      }
    }
  }
  console.log('\n');
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length * 0.5)];
  const p95 = ms[Math.floor(ms.length * 0.95)];
  const hit = rows.filter((r) => String(r.cache).includes('HIT')).length;
  console.log(`n=${rows.length} p50=${p50}ms p95=${p95}ms cacheHit=${((hit / rows.length) * 100).toFixed(1)}%`);
  for (const v of VIEWPORTS) {
    const sub = rows.filter((r) => r.viewport === v.name).map((r) => r.ms).sort((a, b) => a - b);
    console.log(` ${v.name}: p50=${sub[Math.floor(sub.length * 0.5)]}ms p95=${sub[Math.floor(sub.length * 0.95)]}ms`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
