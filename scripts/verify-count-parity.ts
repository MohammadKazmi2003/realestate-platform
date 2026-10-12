// Count/marker parity verification across two servers running different count
// strategies (A: SPLIT_COUNTS=1 default; B: SPLIT_COUNTS=0) plus direct-ES
// ground truth from the SHARED buildFilters population (AD3).
//
// Usage:
//   npx tsx scripts/verify-count-parity.ts --a=http://localhost:3200 --b=http://localhost:3201 --flush=true
//
// The flush between phases guarantees neither server answers from the other's
// (or its own) cached payloads.
import 'dotenv/config';
import { execSync } from 'child_process';
import { buildCountQuery, buildFilters } from '@/lib/esQueryBuilder';
import { getElasticsearchClient } from '@/lib/elasticsearch';
import { coveringTileUnionBounds } from '@/lib/mapTiles';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const A = String(args.a || 'http://localhost:3200');
const B = String(args.b || 'http://localhost:3201');
const DO_FLUSH = args.flush !== 'false';

const es: any = getElasticsearchClient();

const DELHI = { minLat: 28.30, maxLat: 28.80, minLng: 76.90, maxLng: 77.50 };
const DUBAI = { minLat: 24.95, maxLat: 25.45, minLng: 55.05, maxLng: 55.55 };
const COUNTRY = { minLat: 8.0, maxLat: 35.0, minLng: 54.0, maxLng: 97.0 };

type Scenario = { name: string; bounds: any; zoom: number; params: Record<string, any> };

const scenarios: Scenario[] = [
  { name: 'delhi_z11_both_newest', bounds: DELHI, zoom: 11, params: { scope: 'both', sort: 'newest', listingPurpose: 'Sell' } },
  { name: 'delhi_z11_both_price_desc', bounds: DELHI, zoom: 11, params: { scope: 'both', sort: 'price_desc', listingPurpose: 'Sell' } },
  { name: 'delhi_z11_props', bounds: DELHI, zoom: 11, params: { scope: 'properties', sort: 'newest', listingPurpose: 'Sell' } },
  { name: 'delhi_z11_price_filter', bounds: DELHI, zoom: 11, params: { scope: 'both', sort: 'newest', listingPurpose: 'Sell', minPrice: 5000000, maxPrice: 50000000 } },
  { name: 'delhi_z11_bhk', bounds: DELHI, zoom: 11, params: { scope: 'both', sort: 'newest', listingPurpose: 'Sell', bhkType: '3 BHK' } },
  { name: 'delhi_z11_type', bounds: DELHI, zoom: 11, params: { scope: 'both', sort: 'newest', listingPurpose: 'Sell', propertyType: 'Residential Apartment' } },
  { name: 'delhi_z11_rent', bounds: DELHI, zoom: 11, params: { scope: 'properties', sort: 'newest', listingPurpose: 'Rent' } },
  { name: 'dubai_z10_both_newest', bounds: DUBAI, zoom: 10, params: { scope: 'both', sort: 'newest' } },
  { name: 'dubai_z10_projects', bounds: DUBAI, zoom: 10, params: { scope: 'projects', sort: 'newest' } },
  { name: 'dubai_z10_price_asc', bounds: DUBAI, zoom: 10, params: { scope: 'both', sort: 'price_asc' } },
  { name: 'country_z4_both', bounds: COUNTRY, zoom: 4, params: { scope: 'both', sort: 'newest' } },
  { name: 'delhi_z13_street', bounds: { minLat: 28.55, maxLat: 28.60, minLng: 77.20, maxLng: 77.25 }, zoom: 13, params: { scope: 'both', sort: 'newest' } },
];

function mapDataUrl(base: string, s: Scenario): string {
  const c = coveringTileUnionBounds(s.bounds, s.zoom);
  const qp = new URLSearchParams({
    minLat: c.minLat.toFixed(6), maxLat: c.maxLat.toFixed(6),
    minLng: c.minLng.toFixed(6), maxLng: c.maxLng.toFixed(6),
    zoom: String(s.zoom), pageSize: '24',
  });
  for (const [k, v] of Object.entries(s.params)) if (v != null && v !== '') qp.set(k, String(v));
  return `${base}/api/map-data?${qp.toString()}`;
}

async function fetchScenario(base: string, s: Scenario, ip: string) {
  const res = await fetch(mapDataUrl(base, s), { headers: { 'x-forwarded-for': ip } });
  const body: any = await res.json();
  return {
    status: res.status,
    total: body.total,
    totalRelation: body.totalRelation,
    propertyTotal: body.propertyTotal,
    projectTotal: body.projectTotal,
    resultIds: (body.results || []).map((r: any) => r.id).sort(),
    markerIds: (body.markers || []).map((m: any) => `${m.entity_type || ''}:${m.id}`).sort(),
  };
}

function flush() {
  try {
    execSync('node scripts/flush-app-cache.mjs', { stdio: 'pipe' });
  } catch (e: any) {
    console.log(`flush failed: ${e?.message}`);
  }
}

let failures = 0;

async function main() {
  if (DO_FLUSH) { console.log('flushing caches...'); flush(); }
  console.log(`fetching ${scenarios.length} scenarios from A=${A} (split counts)...`);
  const aResults: Record<string, any> = {};
  let ip = 0;
  for (const s of scenarios) aResults[s.name] = await fetchScenario(A, s, `10.7.0.${++ip}`);

  if (DO_FLUSH) { console.log('flushing caches...'); flush(); }
  console.log(`fetching ${scenarios.length} scenarios from B=${B} (inline counts)...`);
  const bResults: Record<string, any> = {};
  for (const s of scenarios) bResults[s.name] = await fetchScenario(B, s, `10.8.0.${++ip}`);

  console.log('\nscenario                      A.total B.total ES.total  A/B markers  result');
  for (const s of scenarios) {
    const { must, filters } = buildFilters(
      { bounds: coveringTileUnionBounds(s.bounds, s.zoom), ...s.params },
      String(s.params.scope || 'both')
    );
    const gt: any = await es.search(buildCountQuery(must, filters, String(s.params.scope || 'both')));
    const gtTotal = gt.hits?.total?.value ?? gt.hits?.total ?? 0;
    const a = aResults[s.name];
    const b = bResults[s.name];
    // Parity contract: both count strategies describe the SAME population
    // (exact totals, same relation, same documents, same markers). The direct
    // GT is informational: it is built without the server's widen-only
    // normalization (price snapping, dust-trim, double tile-union coverage),
    // so GT <= server is expected — never server < GT, which would mean the
    // server narrowed a population (AD5 violation).
    const totalsMatch = a.total === b.total && a.totalRelation === b.totalRelation;
    const gtSafe = a.total >= gtTotal && b.total >= gtTotal;
    const markersMatch = a.markerIds.join('|') === b.markerIds.join('|');
    const resultsMatch = a.resultIds.join('|') === b.resultIds.join('|');
    const ok = totalsMatch && gtSafe && markersMatch && resultsMatch;
    if (!ok) failures++;
    console.log(
      `${s.name.padEnd(28)} ${String(a.total).padStart(7)} ${String(b.total).padStart(7)} ${String(gtTotal).padStart(8)}  ` +
      `markers ${a.markerIds.length}/${b.markerIds.length} ${markersMatch ? 'OK ' : 'DIFF'} results ${resultsMatch ? 'OK ' : 'DIFF'} gt<=server ${gtSafe ? 'OK ' : 'VIOLATION'} => ${ok ? 'PASS' : 'FAIL'}`
    );
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
