// Build the tenant admin-1 boundary asset used by interactive state selection.
//
// Sources (both more accurate than Natural Earth admin-1, which was measured to
// exclude South Mumbai, Dubai Marina and Dubai Creek):
//   India  — geohacker/india state boundaries (MIT, includes Telangana):
//            https://raw.githubusercontent.com/geohacker/india/master/state/india_telengana.geojson
//   UAE    — geoBoundaries gbOpen ARE ADM1 (CC BY 4.0):
//            https://www.geoboundaries.org/api/current/gbOpen/ARE/ADM1/
// Both downloads are cached under scripts/data/ (gitignored); only the built
// asset is committed. Attribution: geohacker/india (MIT), geoBoundaries (CC BY).
//
// Outputs:
//   public/geo/in-ae-admin1.geojson   — OVERVIEW: simplified (≤4000 pts, ≤32
//     rings per state) for instant first paint at country/state zoom.
//   public/geo/detail/<ID>.geojson    — DETAIL: the full raw outer rings (no
//     simplification, every ring), fetched per state on selection and used for
//     BOTH the displayed outline and the ES filter. Stored once, served gzipped
//     and cached by /api/admin-geo?state=<ID>. This is what renders islands like
//     the Palm and coastal detail at pixel level.
//
// Usage: node scripts/build-admin-geo.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { execSync } from 'child_process';

const INDIA_SRC = 'scripts/data/india_states.geojson';
const INDIA_URL = 'https://raw.githubusercontent.com/geohacker/india/master/state/india_telengana.geojson';
const UAE_SRC = 'scripts/data/uae_adm1.geojson';
const UAE_API = 'https://www.geoboundaries.org/api/current/gbOpen/ARE/ADM1/';
const OUT = 'public/geo/in-ae-admin1.geojson';
const DETAIL_DIR = 'public/geo/detail';
// Kept under tenants/default.json filterNormalization.polygonMaxPoints (60000),
// because the server's normalizer STRIDE-DECIMATES (distorts) anything larger.
const MAX_POINTS = 4000;
const MAX_RINGS = 32;
// Detail is raw (no simplification); this is only a safety ceiling.
const DETAIL_MAX_POINTS = 200000;
const DETAIL_MAX_RINGS = 512;

// Feature identity: ISO 3166-2 so ids are stable across data updates.
// Display names are canonicalized where the source uses legacy names.
const INDIA_STATES = {
  'Andaman and Nicobar': { id: 'IN-AN', name: 'Andaman and Nicobar Islands' },
  'Andhra Pradesh': { id: 'IN-AP', name: 'Andhra Pradesh' },
  'Arunachal Pradesh': { id: 'IN-AR', name: 'Arunachal Pradesh' },
  'Assam': { id: 'IN-AS', name: 'Assam' },
  'Bihar': { id: 'IN-BR', name: 'Bihar' },
  'Chandigarh': { id: 'IN-CH', name: 'Chandigarh' },
  'Chhattisgarh': { id: 'IN-CT', name: 'Chhattisgarh' },
  'Dadra and Nagar Haveli': { id: 'IN-DN', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  'Daman and Diu': { id: 'IN-DD', name: 'Daman and Diu' },
  'Delhi': { id: 'IN-DL', name: 'Delhi' },
  'Goa': { id: 'IN-GA', name: 'Goa' },
  'Gujarat': { id: 'IN-GJ', name: 'Gujarat' },
  'Haryana': { id: 'IN-HR', name: 'Haryana' },
  'Himachal Pradesh': { id: 'IN-HP', name: 'Himachal Pradesh' },
  'Jammu and Kashmir': { id: 'IN-JK', name: 'Jammu and Kashmir' },
  'Jharkhand': { id: 'IN-JH', name: 'Jharkhand' },
  'Karnataka': { id: 'IN-KA', name: 'Karnataka' },
  'Kerala': { id: 'IN-KL', name: 'Kerala' },
  'Lakshadweep': { id: 'IN-LD', name: 'Lakshadweep' },
  'Madhya Pradesh': { id: 'IN-MP', name: 'Madhya Pradesh' },
  'Maharashtra': { id: 'IN-MH', name: 'Maharashtra' },
  'Manipur': { id: 'IN-MN', name: 'Manipur' },
  'Meghalaya': { id: 'IN-ML', name: 'Meghalaya' },
  'Mizoram': { id: 'IN-MZ', name: 'Mizoram' },
  'Nagaland': { id: 'IN-NL', name: 'Nagaland' },
  'Orissa': { id: 'IN-OD', name: 'Odisha' },
  'Puducherry': { id: 'IN-PY', name: 'Puducherry' },
  'Punjab': { id: 'IN-PB', name: 'Punjab' },
  'Rajasthan': { id: 'IN-RJ', name: 'Rajasthan' },
  'Sikkim': { id: 'IN-SK', name: 'Sikkim' },
  'Tamil Nadu': { id: 'IN-TN', name: 'Tamil Nadu' },
  'Telangana': { id: 'IN-TG', name: 'Telangana' },
  'Tripura': { id: 'IN-TR', name: 'Tripura' },
  'Uttar Pradesh': { id: 'IN-UP', name: 'Uttar Pradesh' },
  'Uttaranchal': { id: 'IN-UT', name: 'Uttarakhand' },
  'West Bengal': { id: 'IN-WB', name: 'West Bengal' },
};

// Coverage smoke checks for the DETAIL geometry: failing any of these means the
// source data or the extraction regressed in exactly the way this script exists
// to prevent (the Palm crescent is the regression that shipped to users).
const DETAIL_ANCHORS = [
  ['AE-DU', 55.14, 25.135, 'Palm Jumeirah crescent'],
  ['AE-DU', 55.137, 25.112, 'Palm Jumeirah trunk'],
];

// Coverage smoke checks for the OVERVIEW geometry: failing any of these means
// the simplification or the source data regressed in exactly the way this
// script exists to prevent.
const ANCHORS = [
  ['IN-MH', 72.835, 18.94, 'Mumbai CST'],
  ['IN-MH', 72.815, 18.905, 'Colaba'],
  ['IN-MH', 72.83, 19.06, 'Bandra'],
  ['IN-MH', 72.87, 19.12, 'Andheri'],
  ['IN-MH', 72.978, 19.218, 'Thane'],
  ['IN-MH', 73.11, 18.99, 'Panvel'],
  ['AE-DU', 55.061, 25.011, 'Jebel Ali'],
  ['AE-DU', 55.14, 25.08, 'Dubai Marina'],
  ['AE-DU', 55.31, 25.26, 'Dubai Creek'],
  ['AE-DU', 55.274, 25.197, 'Burj Khalifa'],
  ['AE-DU', 56.12, 24.80, 'Hatta exclave'],
  ['AE-SH', 55.39, 25.35, 'Sharjah city'],
  ['AE-AZ', 54.37, 24.45, 'Abu Dhabi city'],
];

function download(src, url) {
  if (existsSync(src)) return;
  mkdirSync('scripts/data', { recursive: true });
  console.log(`downloading ${url} ...`);
  execSync(`curl -sL --max-time 300 -o ${src} ${url}`, { stdio: 'inherit' });
}

// ---- Douglas-Peucker (open polyline; rings are re-closed) ----------------------
function simplifyOpen(ring, tolerance) {
  const n = ring.length;
  if (n <= 3) return ring.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const [ax, ay] = ring[first];
    const [bx, by] = ring[last];
    const dx = bx - ax;
    const dy = by - ay;
    const mag = Math.hypot(dx, dy) || 1e-12;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = ring[i];
      const dist = Math.abs(dy * (px - ax) - dx * (py - ay)) / mag;
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

function closeRing(ring) {
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  return ring;
}

function simplifyRing(ring, tolerance) {
  const closed = ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring.slice();
  if (open.length <= 3) return closeRing(open);
  return closeRing(simplifyOpen(open, tolerance));
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a / 2);
}

function pointCount(rings) {
  return rings.reduce((a, r) => a + r.length, 0);
}

if (!existsSync(UAE_SRC)) {
  const api = JSON.parse(execSync(`curl -sL --max-time 60 ${UAE_API}`, { encoding: 'utf8' }));
  download(UAE_SRC, api.gjDownloadURL);
} else {
  download(UAE_SRC, UAE_API);
}
download(INDIA_SRC, INDIA_URL);

function outerRings(feature) {
  const g = feature.geometry;
  if (!g) return [];
  const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
  return polys.map((p) => p[0]).filter((r) => Array.isArray(r) && r.length >= 4);
}

function simplifyFeature(feature) {
  let rings = outerRings(feature)
    .map((r) => closeRing(r.slice()))
    .sort((a, b) => ringArea(b) - ringArea(a));
  const droppedRings = Math.max(0, rings.length - MAX_RINGS);
  rings = rings.slice(0, MAX_RINGS);

  const tolerances = [0.0002, 0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032];
  for (const tol of tolerances) {
    rings = rings.map((r) => simplifyRing(r, tol));
    if (pointCount(rings) <= MAX_POINTS) break;
  }
  if (pointCount(rings) > MAX_POINTS) {
    const total = pointCount(rings);
    rings = rings.map((r) => {
      const keep = Math.max(4, Math.floor((r.length / total) * MAX_POINTS));
      if (r.length <= keep) return r;
      const stride = r.length / keep;
      const out = [];
      for (let i = 0; i < keep; i++) out.push(r[Math.floor(i * stride)]);
      return closeRing(out);
    });
  }
  rings = rings.filter((r) => r.length >= 4);
  if (!rings.length) return null;

  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { rings, bbox: [minLng, minLat, maxLng, maxLat], droppedRings };
}

function bboxOf(rings) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

function geometryFor(rings) {
  return rings.length === 1
    ? { type: 'Polygon', coordinates: [rings[0]] }
    : { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) };
}

const features = [];
const detailFeatures = [];
const skipped = [];

// India (geohacker) — NAME_1 → ISO 3166-2.
const india = JSON.parse(readFileSync(INDIA_SRC, 'utf8'));
for (const f of india.features) {
  const name = f.properties?.NAME_1;
  const meta = INDIA_STATES[name];
  if (!meta) {
    skipped.push(`IN:${name}`);
    continue;
  }
  const metaProps = { id: meta.id, name: meta.name, country: 'India', countryCode: 'IN' };

  const detailRings = outerRings(f).map((r) => closeRing(r.slice()));
  if (detailRings.length) {
    detailFeatures.push({
      type: 'Feature',
      id: meta.id,
      properties: { ...metaProps, bbox: bboxOf(detailRings), points: pointCount(detailRings), rings: detailRings.length },
      geometry: geometryFor(detailRings),
    });
  }

  const simplified = simplifyFeature(f);
  if (!simplified) {
    skipped.push(`IN:${name} (no geometry)`);
    continue;
  }
  const { rings, bbox, droppedRings } = simplified;
  features.push({
    type: 'Feature',
    id: meta.id,
    properties: { ...metaProps, bbox, points: pointCount(rings), rings: rings.length, droppedRings },
    geometry: geometryFor(rings),
  });
}

// UAE (geoBoundaries) — shapeISO is already AE-XX.
const uae = JSON.parse(readFileSync(UAE_SRC, 'utf8'));
for (const f of uae.features) {
  const id = (f.properties?.shapeISO || '').trim();
  const name = f.properties?.shapeName || id;
  if (!/^AE-[A-Z]{2}$/.test(id)) {
    skipped.push(`AE:${id || name}`);
    continue;
  }
  const metaProps = { id, name, country: 'United Arab Emirates', countryCode: 'AE' };

  const detailRings = outerRings(f).map((r) => closeRing(r.slice()));
  if (detailRings.length) {
    detailFeatures.push({
      type: 'Feature',
      id,
      properties: { ...metaProps, bbox: bboxOf(detailRings), points: pointCount(detailRings), rings: detailRings.length },
      geometry: geometryFor(detailRings),
    });
  }

  const simplified = simplifyFeature(f);
  if (!simplified) {
    skipped.push(`AE:${id} (no geometry)`);
    continue;
  }
  const { rings, bbox, droppedRings } = simplified;
  features.push({
    type: 'Feature',
    id,
    properties: { ...metaProps, bbox, points: pointCount(rings), rings: rings.length, droppedRings },
    geometry: geometryFor(rings),
  });
}

// ---- anchor validation ----------------------------------------------------------
function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inFeature(lng, lat, f) {
  const g = f.geometry;
  const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
  return polys.some((p) => inRing(lng, lat, p[0]));
}

const SOURCES = [
  { name: 'geohacker/india state boundaries', license: 'MIT' },
  { name: 'geoBoundaries gbOpen ARE ADM1', license: 'CC BY 4.0' },
];

const errors = [];
for (const [id, lng, lat, label] of [...ANCHORS, ...DETAIL_ANCHORS]) {
  const f = detailFeatures.find((x) => x.id === id);
  if (!f) errors.push(`detail anchor ${label}: region ${id} missing`);
  else if (!inFeature(lng, lat, f)) errors.push(`detail anchor ${label} (${lng},${lat}) outside ${id}`);
}
for (const [id, lng, lat, label] of ANCHORS) {
  const f = features.find((x) => x.id === id);
  if (!f) errors.push(`anchor ${label}: region ${id} missing`);
  else if (!inFeature(lng, lat, f)) errors.push(`anchor ${label} (${lng},${lat}) outside ${id}`);
}
for (const f of features) {
  if (f.properties.points > MAX_POINTS || f.properties.rings > MAX_RINGS) {
    errors.push(`overview cap violation ${f.id}: points=${f.properties.points} rings=${f.properties.rings}`);
  }
}
for (const f of detailFeatures) {
  if (f.properties.points > DETAIL_MAX_POINTS || f.properties.rings > DETAIL_MAX_RINGS) {
    errors.push(`detail cap violation ${f.id}: points=${f.properties.points} rings=${f.properties.rings}`);
  }
}

const out = { type: 'FeatureCollection', name: 'in-ae-admin1', sources: SOURCES, features };
mkdirSync('public/geo', { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const bytes = readFileSync(OUT).length;
const maxPoints = Math.max(...features.map((f) => f.properties.points));
const maxRings = Math.max(...features.map((f) => f.properties.rings));

if (errors.length) {
  console.error('VALIDATION FAILED:\n' + errors.join('\n'));
  process.exit(1);
}

// Detail per state: stored once, served on demand (gzipped) by /api/admin-geo.
mkdirSync(DETAIL_DIR, { recursive: true });
let detailBytes = 0;
let detailMax = { id: '', bytes: 0 };
for (const f of detailFeatures) {
  const file = `${DETAIL_DIR}/${f.id}.geojson`;
  const body = JSON.stringify({ type: 'FeatureCollection', name: 'in-ae-admin1-detail', sources: SOURCES, features: [f] });
  writeFileSync(file, body);
  const n = Buffer.byteLength(body);
  detailBytes += n;
  if (n > detailMax.bytes) detailMax = { id: f.id, bytes: n };
}

console.log(
  `wrote ${OUT}: ${features.length} features, ${(bytes / 1024).toFixed(0)} KB, max points/state=${maxPoints}, max rings/state=${maxRings}`
);
console.log(
  `wrote ${DETAIL_DIR}: ${detailFeatures.length} states, ${(detailBytes / 1048576).toFixed(1)} MB total, largest=${detailMax.id} ${(detailMax.bytes / 1048576).toFixed(2)} MB, max points/state=${Math.max(...detailFeatures.map((f) => f.properties.points))}, max rings/state=${Math.max(...detailFeatures.map((f) => f.properties.rings))}`
);
if (skipped.length) console.log(`skipped features: ${skipped.join(', ')}`);
console.log(`anchor checks passed (overview ${ANCHORS.length}, detail ${ANCHORS.length + DETAIL_ANCHORS.length})`);

// Remove the superseded Natural Earth download if present (39 MB, inaccurate).
if (existsSync('scripts/data/ne_10m_admin_1.geojson')) {
  rmSync('scripts/data/ne_10m_admin_1.geojson');
  console.log('removed outdated scripts/data/ne_10m_admin_1.geojson');
}
