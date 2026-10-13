// End-to-end verification of interactive state/emirate selection.
//
// Ground truth is hole-aware point-in-polygon against the SAME canonical
// MapTiler geometry the map renders and the server filters by (no stored
// classification exists anymore). This cross-checks:
//   1. /api/state-counts totals equal the PIP population of the canonical shapes
//   2. GET /api/map-data?state=… totals match and every result is PIP-inside
//      (holes excluded, islands included)
//   3. markers=false overview returns no markers, same exact totals
//   4. metro anchors (Mumbai/Pune/Bangalore/Hyderabad/Delhi/Dubai) are fully
//      included by the exact clause the server builds
//   5. hole interiors are excluded by the same clause
//   6. unknown state ids are rejected
//
// Usage: npx tsx scripts/verify-state-selection.ts [--base=http://localhost:3000]
import { getAdminRegion, listAdminRegions, type AdminRegion, type RegionShape } from '@/lib/adminRegionsServer';
import { boundaryClauseFromShapes } from '@/lib/esQueryBuilder';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const BASE = String(args.base || 'http://localhost:3000');
const ES = String(args.es || process.env.ELASTICSEARCH_URL || 'http://localhost:9200');
const INDEXES = 'properties_search,projects_search';
const STATES = ['IN-MH', 'IN-KA', 'IN-DL', 'IN-TG', 'AE-DU', 'IN-GJ', 'IN-TN', 'IN-AN', 'AE-AZ'];

let ipCounter = 0;
const nextIp = () => `10.21.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

type Doc = { lat: number; lon: number };

function inRing(lng: number, lat: number, ring: { lat: number; lng: number }[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const { lat: yi, lng: xi } = ring[i];
    const { lat: yj, lng: xj } = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function containsShape(shape: RegionShape, lng: number, lat: number) {
  return inRing(lng, lat, shape.outer) && !shape.holes.some((h) => inRing(lng, lat, h));
}

function contains(region: AdminRegion, lng: number, lat: number) {
  return region.shapes.some((s) => containsShape(s, lng, lat));
}

async function loadLiveDocs(): Promise<Doc[]> {
  const res = await fetch(`${ES}/${INDEXES}/_search?size=10000`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: { match_all: {} }, _source: ['location'] }),
  });
  if (!res.ok) throw new Error(`ES scan failed: ${res.status}`);
  const json: any = await res.json();
  const docs: Doc[] = [];
  for (const hit of json.hits?.hits || []) {
    const loc = hit._source?.location || {};
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) continue;
    docs.push({ lat: loc.lat, lon: loc.lon });
  }
  return docs;
}

function bboxParams(id: string) {
  const r = getAdminRegion(id)!;
  const [minLng, minLat, maxLng, maxLat] = r.bbox;
  return { minLat: round6(minLat), maxLat: round6(maxLat), minLng: round6(minLng), maxLng: round6(maxLng) };
}

async function main() {
  console.log(`# state selection verification base=${BASE} states=${STATES.join(',')}`);
  const regions = listAdminRegions();
  check('canonical regions loaded', regions.length === 43, `${regions.length} regions`);

  const docs = await loadLiveDocs();
  check('live corpus scanned', docs.length > 0, `${docs.length} docs`);

  const inBbox = (d: Doc, b: { minLat: number; maxLat: number; minLng: number; maxLng: number }) =>
    d.lat >= b.minLat && d.lat <= b.maxLat && d.lon >= b.minLng && d.lon <= b.maxLng;

  for (const id of STATES) {
    const region = getAdminRegion(id)!;
    const b = bboxParams(id);
    const headers = { 'x-forwarded-for': nextIp() };
    const gt = docs.filter((d) => contains(region, d.lon, d.lat)).length;

    // 1. Direct PIP population vs /api/state-counts
    const scRes = await fetch(`${BASE}/api/state-counts?state=${encodeURIComponent(id)}&scope=both`, { headers });
    const sc = scRes.ok ? await scRes.json() : null;
    check(`${id}: state-counts parity`, scRes.ok && sc?.total === gt, `api=${sc?.total} pip=${gt} status=${scRes.status}`);

    // 2. map-data with state (list+count path)
    const qp = new URLSearchParams({
      minLat: String(b.minLat), maxLat: String(b.maxLat), minLng: String(b.minLng), maxLng: String(b.maxLng),
      zoom: '6', scope: 'both', sort: 'newest', pageSize: '24', state: id,
    });
    const mdRes = await fetch(`${BASE}/api/map-data?${qp}`, { headers });
    const md = mdRes.ok ? await mdRes.json() : null;
    check(`${id}: map-data 200`, mdRes.ok, `status=${mdRes.status}`);
    check(`${id}: map-data total == PIP count`, md?.total === gt, `api=${md?.total} pip=${gt}`);
    const results = md?.results || [];
    const inside = results.filter((x: any) => {
      const lat = x.location?.lat;
      const lon = x.location?.lon;
      return lat != null && lon != null && contains(region, lon, lat);
    }).length;
    check(`${id}: every result PIP-inside (holes excluded)`, results.length === 0 || inside === results.length, `${inside}/${results.length}`);

    // 3. Overview mode: markers skipped entirely, same exact totals
    const ovQp = new URLSearchParams(qp);
    ovQp.set('zoom', '4');
    ovQp.set('markers', 'false');
    const ovRes = await fetch(`${BASE}/api/map-data?${ovQp}`, { headers });
    const ov = ovRes.ok ? await ovRes.json() : null;
    check(`${id}: overview markers=false -> empty markers`, Array.isArray(ov?.markers) && ov.markers.length === 0, `markers=${ov?.markers?.length}`);
    check(`${id}: overview total unchanged`, ov?.total === gt, `api=${ov?.total} pip=${gt}`);

    // 4. Pills accept the state filter
    const pgRes = await fetch(`${BASE}/api/project-groups?${qp}`, { headers });
    const pg = pgRes.ok ? await pgRes.json() : null;
    check(`${id}: project-groups accepts state`, pgRes.ok && Array.isArray(pg?.projectGroups), `status=${pgRes.status}`);
  }

  // 5. Metro coverage in the FILTER: the exact clause the server builds
  // (geo_polygon + must_not holes) must return every listing PIP-inside the box.
  const METRO_BBOXES: [string, [number, number, number, number], string][] = [
    ['IN-MH', [72.75, 18.85, 73.05, 19.30], 'Mumbai metro'],
    ['IN-MH', [73.80, 18.47, 73.93, 18.58], 'Pune core'],
    ['IN-KA', [77.55, 12.92, 77.68, 13.03], 'Bangalore core'],
    ['IN-TG', [78.42, 17.33, 78.55, 17.44], 'Hyderabad core'],
    ['IN-DL', [77.17, 28.57, 77.27, 28.67], 'Central Delhi'],
    ['AE-DU', [55.25, 25.17, 55.31, 25.23], 'Downtown Dubai'],
  ];
  for (const [id, [minLng, minLat, maxLng, maxLat], label] of METRO_BBOXES) {
    const region = getAdminRegion(id)!;
    const box = { minLat, maxLat, minLng, maxLng };
    const expected = docs.filter((d) => contains(region, d.lon, d.lat) && inBbox(d, box)).length;
    if (expected === 0) {
      console.log(`SKIP  ${id} ${label}: no listings in bbox`);
      continue;
    }
    const clause = boundaryClauseFromShapes(region.shapes)!;
    const res = await fetch(`${ES}/${INDEXES}/_count`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: {
          bool: {
            filter: [
              { term: { status: 'available' } },
              clause,
              {
                geo_bounding_box: {
                  location: {
                    top_left: { lat: maxLat, lon: minLng },
                    bottom_right: { lat: minLat, lon: maxLng },
                  },
                },
              },
            ],
          },
        },
      }),
    });
    const body: any = await res.json();
    check(`${id} filter includes ${label} listings`, body?.count === expected, `es=${body?.count} expected=${expected}`);
  }

  // 6. Hole interiors are excluded by the exact server clause: any doc sitting
  // inside a hole must not be returned, and the clause must agree with PIP.
  for (const id of ['IN-GJ', 'IN-TN']) {
    const region = getAdminRegion(id)!;
    const holed = region.shapes.find((s) => s.holes.length > 0);
    if (!holed) continue;
    const hole = holed.holes[0];
    const probe = (() => {
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of hole) {
        bb[0] = Math.min(bb[0], p.lng);
        bb[1] = Math.min(bb[1], p.lat);
        bb[2] = Math.max(bb[2], p.lng);
        bb[3] = Math.max(bb[3], p.lat);
      }
      for (let gx = 1; gx < 30; gx++) {
        for (let gy = 1; gy < 30; gy++) {
          const lng = bb[0] + ((bb[2] - bb[0]) * gx) / 30;
          const lat = bb[1] + ((bb[3] - bb[1]) * gy) / 30;
          if (inRing(lng, lat, hole)) return { lng, lat };
        }
      }
      return null;
    })();
    if (!probe) continue;
    const pad = 0.02;
    const box = { minLat: probe.lat - pad, maxLat: probe.lat + pad, minLng: probe.lng - pad, maxLng: probe.lng + pad };
    const expected = docs.filter((d) => contains(region, d.lon, d.lat) && inBbox(d, box)).length;
    const clause = boundaryClauseFromShapes(region.shapes)!;
    const res = await fetch(`${ES}/${INDEXES}/_count`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: {
          bool: {
            filter: [
              { term: { status: 'available' } },
              clause,
              {
                geo_bounding_box: {
                  location: { top_left: { lat: box.maxLat, lon: box.minLng }, bottom_right: { lat: box.minLat, lon: box.maxLng } },
                },
              },
            ],
          },
        },
      }),
    });
    const body: any = await res.json();
    check(`${id} hole probe excluded`, body?.count === expected, `es=${body?.count} expected=${expected} probe=${probe.lng.toFixed(4)},${probe.lat.toFixed(4)}`);
  }

  // 7. Unknown state is rejected, never silently unfiltered.
  const bad = await fetch(`${BASE}/api/map-data?minLat=10&maxLat=20&minLng=70&maxLng=80&zoom=6&state=XX-XX`, { headers: { 'x-forwarded-for': nextIp() } });
  check('unknown state -> 400', bad.status === 400, `status=${bad.status}`);
  const badCount = await fetch(`${BASE}/api/state-counts?state=XX-XX`, { headers: { 'x-forwarded-for': nextIp() } });
  check('unknown state count -> 400', badCount.status === 400, `status=${badCount.status}`);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
