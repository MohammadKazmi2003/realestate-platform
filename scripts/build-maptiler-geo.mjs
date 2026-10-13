// Build the canonical admin-1 boundary assets for interactive state selection.
//
// Source: MapTiler Geocoding API (region polygons), which returns the boundary
// geometry verbatim for a `region.<id>` lookup. This replaced the previous
// geohacker/geoBoundaries build because the product decision is to render and
// filter with exactly the MapTiler shape (holes and islands included), rather
// than approximating it.
//
// Pipeline per region:
//   1. search the name with `types=region` (country-scoped) -> region id
//   2. look the id up -> full Polygon/MultiPolygon geometry
//   3. validate: anchors (hole-aware PIP), bbox IoU vs the previous asset,
//      caps. Any failure exits non-zero before anything is written.
//
// Outputs:
//   public/geo/regions/<ID>.geojson  — CANONICAL: geometry exactly as MapTiler
//     returns it (no simplification). Used for hover/selection rendering and
//     for the ES geo_polygon filter.
//   public/geo/regions-manifest.json — per-region metadata + sha256 + version.
//     The sha is the cache-bust token (?v=) for canonical fetches.
//   public/geo/overview.geojson      — OVERVIEW: artifact-safe simplification
//     for the always-on background layer only. Interactions always use the
//     canonical file; the overview may never stand in for a selected outline.
//
// Known, deliberate deviations from the previous asset (recorded so they are
// not mistaken for bugs):
//   - UAE emirates are MapTiler's sea-envelope shapes (Dubai covers the
//     islands and the water between them).
//   - IN-JK merges region.822 + Ladakh region.1854 to preserve the previous
//     "Jammu and Kashmir" coverage (the product has no separate Ladakh chip).
//   - IN-DN and IN-DD share the combined DNH & DD region.716 (merged UT since
//     2020), because MapTiler no longer returns Daman and Diu separately.
//
// Raw API responses are cached under scripts/data/maptiler/ (gitignored);
// only the built assets are committed. Attribution: © MapTiler © OpenStreetMap
// contributors (stored in the manifest and rendered in the map attribution).
//
// Usage: node scripts/build-maptiler-geo.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const OUT_DIR = 'public/geo/regions';
const MANIFEST = 'public/geo/regions-manifest.json';
const OVERVIEW = 'public/geo/overview.geojson';
const CACHE_DIR = 'scripts/data/maptiler';
const REPORT = 'bench-results/maptiler-geo-report.json';
const PREV_OVERVIEW = 'public/geo/in-ae-admin1.geojson';
const PREV_DETAIL_DIR = 'public/geo/detail';

const ATTRIBUTION = '© MapTiler © OpenStreetMap contributors';

// Safety ceilings. Canonical geometry is verbatim; these only guard against a
// data explosion that would make the ES filter or the assets unusable.
const MAX_POINTS = 200000;
const MAX_RINGS = 1024;
const MAX_OVERVIEW_POINTS = 4000;
const MAX_OVERVIEW_RINGS = 64;

const INDIA = 'India';
const UAE = 'United Arab Emirates';

// Stable ISO 3166-2 ids. `search` defaults to the display name; overrides only
// where the plain name resolves to the wrong feature.
const REGIONS = [
  { id: 'IN-AN', name: 'Andaman and Nicobar Islands', country: INDIA, countryCode: 'IN' },
  { id: 'IN-TG', name: 'Telangana', country: INDIA, countryCode: 'IN' },
  { id: 'IN-AP', name: 'Andhra Pradesh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-AR', name: 'Arunachal Pradesh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-AS', name: 'Assam', country: INDIA, countryCode: 'IN' },
  { id: 'IN-BR', name: 'Bihar', country: INDIA, countryCode: 'IN' },
  { id: 'IN-CH', name: 'Chandigarh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-CT', name: 'Chhattisgarh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-DN', name: 'Dadra and Nagar Haveli and Daman and Diu', country: INDIA, countryCode: 'IN', search: 'Dadra and Nagar Haveli and Daman and Diu', skipBboxCheck: true },
  { id: 'IN-DD', name: 'Daman and Diu', country: INDIA, countryCode: 'IN', search: 'Dadra and Nagar Haveli and Daman and Diu', skipBboxCheck: true },
  { id: 'IN-DL', name: 'Delhi', country: INDIA, countryCode: 'IN' },
  { id: 'IN-GA', name: 'Goa', country: INDIA, countryCode: 'IN' },
  { id: 'IN-GJ', name: 'Gujarat', country: INDIA, countryCode: 'IN' },
  { id: 'IN-HR', name: 'Haryana', country: INDIA, countryCode: 'IN' },
  { id: 'IN-HP', name: 'Himachal Pradesh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-JK', name: 'Jammu and Kashmir', country: INDIA, countryCode: 'IN', extraSearches: ['Ladakh'] },
  { id: 'IN-JH', name: 'Jharkhand', country: INDIA, countryCode: 'IN' },
  { id: 'IN-KA', name: 'Karnataka', country: INDIA, countryCode: 'IN' },
  { id: 'IN-KL', name: 'Kerala', country: INDIA, countryCode: 'IN' },
  { id: 'IN-LD', name: 'Lakshadweep', country: INDIA, countryCode: 'IN' },
  { id: 'IN-MP', name: 'Madhya Pradesh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-MH', name: 'Maharashtra', country: INDIA, countryCode: 'IN' },
  { id: 'IN-MN', name: 'Manipur', country: INDIA, countryCode: 'IN' },
  { id: 'IN-ML', name: 'Meghalaya', country: INDIA, countryCode: 'IN' },
  { id: 'IN-MZ', name: 'Mizoram', country: INDIA, countryCode: 'IN' },
  { id: 'IN-NL', name: 'Nagaland', country: INDIA, countryCode: 'IN' },
  { id: 'IN-OD', name: 'Odisha', country: INDIA, countryCode: 'IN' },
  { id: 'IN-PY', name: 'Puducherry', country: INDIA, countryCode: 'IN' },
  { id: 'IN-PB', name: 'Punjab', country: INDIA, countryCode: 'IN' },
  { id: 'IN-RJ', name: 'Rajasthan', country: INDIA, countryCode: 'IN' },
  { id: 'IN-SK', name: 'Sikkim', country: INDIA, countryCode: 'IN' },
  { id: 'IN-TN', name: 'Tamil Nadu', country: INDIA, countryCode: 'IN' },
  { id: 'IN-TR', name: 'Tripura', country: INDIA, countryCode: 'IN' },
  { id: 'IN-UP', name: 'Uttar Pradesh', country: INDIA, countryCode: 'IN' },
  { id: 'IN-UT', name: 'Uttarakhand', country: INDIA, countryCode: 'IN' },
  { id: 'IN-WB', name: 'West Bengal', country: INDIA, countryCode: 'IN' },
  { id: 'AE-AZ', name: 'Abu Dhabi', country: UAE, countryCode: 'AE', search: 'Abu Dhabi Emirate' , skipBboxCheck: true },
  { id: 'AE-AJ', name: 'Ajman', country: UAE, countryCode: 'AE' , skipBboxCheck: true },
  { id: 'AE-DU', name: 'Dubai', country: UAE, countryCode: 'AE' , skipBboxCheck: true },
  { id: 'AE-FU', name: 'Fujairah', country: UAE, countryCode: 'AE' , skipBboxCheck: true },
  { id: 'AE-RK', name: 'Ras al-Khaimah', country: UAE, countryCode: 'AE' , skipBboxCheck: true },
  { id: 'AE-SH', name: 'Sharjah', country: UAE, countryCode: 'AE' , skipBboxCheck: true },
  { id: 'AE-UQ', name: 'Umm al-Quwain', country: UAE, countryCode: 'AE' , skipBboxCheck: true },
];

// Coverage smoke checks. These are the regressions this script exists to
// prevent: wrong-region picks and shapes that drop inhabited islands or
// enclaves. Coordinates are WGS84 [lng, lat].
const ANCHORS = [
  ['IN-AN', 92.75, 11.66, 'Port Blair'],
  ['IN-AN', 92.78, 9.16, 'Car Nicobar'],
  ['IN-AP', 83.3, 17.7, 'Visakhapatnam'],
  ['IN-AP', 80.65, 16.51, 'Vijayawada'],
  ['IN-AR', 93.62, 27.08, 'Itanagar'],
  ['IN-AS', 91.75, 26.14, 'Guwahati'],
  ['IN-AS', 94.9, 27.47, 'Dibrugarh'],
  ['IN-BR', 85.14, 25.59, 'Patna'],
  ['IN-CH', 76.78, 30.73, 'Chandigarh'],
  ['IN-CT', 81.63, 21.25, 'Raipur'],
  ['IN-DN', 73.02, 20.27, 'Silvassa'],
  ['IN-DD', 72.83, 20.42, 'Daman'],
  ['IN-DD', 70.98, 20.71, 'Diu'],
  ['IN-DL', 77.22, 28.63, 'Connaught Place'],
  ['IN-GA', 73.83, 15.5, 'Panaji'],
  ['IN-GJ', 72.57, 23.02, 'Ahmedabad'],
  ['IN-GJ', 72.83, 21.17, 'Surat'],
  ['IN-GJ', 70.8, 22.3, 'Rajkot'],
  ['IN-HR', 77.03, 28.46, 'Gurugram'],
  ['IN-HR', 77.31, 28.41, 'Faridabad'],
  ['IN-HP', 77.17, 31.1, 'Shimla'],
  ['IN-HP', 76.32, 32.22, 'Dharamshala'],
  ['IN-JK', 74.8, 34.08, 'Srinagar'],
  ['IN-JK', 74.87, 32.73, 'Jammu'],
  ['IN-JK', 77.58, 34.15, 'Leh (Ladakh merge)'],
  ['IN-JK', 76.13, 34.56, 'Kargil (Ladakh merge)'],
  ['IN-JH', 85.31, 23.36, 'Ranchi'],
  ['IN-KA', 77.59, 12.97, 'Bengaluru'],
  ['IN-KA', 74.85, 12.91, 'Mangaluru'],
  ['IN-KL', 76.27, 9.97, 'Kochi'],
  ['IN-KL', 76.94, 8.52, 'Thiruvananthapuram'],
  ['IN-LD', 72.64, 10.56, 'Kavaratti'],
  ['IN-MP', 77.41, 23.26, 'Bhopal'],
  ['IN-MP', 75.86, 22.72, 'Indore'],
  ['IN-MH', 72.835, 18.94, 'Mumbai CST'],
  ['IN-MH', 72.815, 18.905, 'Colaba'],
  ['IN-MH', 72.83, 19.06, 'Bandra'],
  ['IN-MH', 72.978, 19.218, 'Thane'],
  ['IN-MH', 73.86, 18.52, 'Pune'],
  ['IN-MH', 79.09, 21.15, 'Nagpur'],
  ['IN-MN', 93.94, 24.82, 'Imphal'],
  ['IN-ML', 91.88, 25.57, 'Shillong'],
  ['IN-MZ', 92.72, 23.73, 'Aizawl'],
  ['IN-NL', 94.11, 25.67, 'Kohima'],
  ['IN-OD', 85.82, 20.27, 'Bhubaneswar'],
  ['IN-PY', 79.83, 11.93, 'Puducherry'],
  ['IN-PY', 75.5405, 11.7356, 'Mahe'],
  ['IN-PY', 79.83, 10.92, 'Karaikal'],
  ['IN-PY', 82.21, 16.73, 'Yanam'],
  ['IN-PB', 74.87, 31.63, 'Amritsar'],
  ['IN-PB', 75.85, 30.9, 'Ludhiana'],
  ['IN-RJ', 75.79, 26.91, 'Jaipur'],
  ['IN-RJ', 73.02, 26.29, 'Jodhpur'],
  ['IN-SK', 88.61, 27.33, 'Gangtok'],
  ['IN-TN', 80.27, 13.08, 'Chennai'],
  ['IN-TN', 78.12, 9.93, 'Madurai'],
  ['IN-TG', 78.48, 17.38, 'Hyderabad'],
  ['IN-TG', 79.59, 17.99, 'Warangal'],
  ['IN-TR', 91.28, 23.83, 'Agartala'],
  ['IN-UP', 80.95, 26.85, 'Lucknow'],
  ['IN-UP', 77.36, 28.57, 'Noida'],
  ['IN-UP', 82.97, 25.32, 'Varanasi'],
  ['IN-UT', 78.03, 30.32, 'Dehradun'],
  ['IN-UT', 79.45, 29.38, 'Nainital'],
  ['IN-WB', 88.36, 22.57, 'Kolkata'],
  ['IN-WB', 88.43, 26.73, 'Siliguri'],
  ['AE-AZ', 54.37, 24.45, 'Abu Dhabi city'],
  ['AE-AZ', 55.74, 24.21, 'Al Ain'],
  ['AE-AZ', 53.77, 23.13, 'Liwa'],
  ['AE-AJ', 55.44, 25.4, 'Ajman city'],
  ['AE-DU', 55.061, 25.011, 'Jebel Ali'],
  ['AE-DU', 55.14, 25.08, 'Dubai Marina'],
  ['AE-DU', 55.274, 25.197, 'Burj Khalifa'],
  ['AE-DU', 56.12, 24.8, 'Hatta exclave'],
  ['AE-DU', 55.18, 25.23, 'World Islands'],
  ['AE-DU', 55.14, 25.135, 'Palm Jumeirah crescent'],
  ['AE-FU', 56.34, 25.12, 'Fujairah city'],
  ['AE-RK', 55.94, 25.79, 'Ras al-Khaimah city'],
  ['AE-SH', 55.39, 25.35, 'Sharjah city'],
  ['AE-SH', 56.36, 25.34, 'Khor Fakkan exclave'],
  ['AE-UQ', 55.55, 25.56, 'Umm al-Quwain city'],
];

// ---- API ----------------------------------------------------------------------
function apiKey() {
  if (process.env.NEXT_PUBLIC_MAPTILER_KEY) return process.env.NEXT_PUBLIC_MAPTILER_KEY.trim();
  const env = readFileSync('.env', 'utf8');
  const m = env.match(/NEXT_PUBLIC_MAPTILER_KEY=(.+)/);
  if (!m) throw new Error('NEXT_PUBLIC_MAPTILER_KEY not found in environment or .env');
  return m[1].trim();
}
const KEY = apiKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(name) {
  return `${CACHE_DIR}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

async function fetchJson(url, cacheName) {
  const file = cachePath(cacheName);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep([2000, 5000, 10000][attempt - 1] ?? 10000);
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`${res.status} ${res.statusText} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
      continue;
    }
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      lastErr = new Error(`non-JSON response for ${url}: ${body.slice(0, 120)}`);
      continue;
    }
    writeFileSync(file, body);
    await sleep(400);
    return json;
  }
  throw lastErr;
}

async function searchRegion(term, countryCode) {
  const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(term)}.json?key=${KEY}&country=${countryCode.toLowerCase()}&types=region&language=en&limit=5`;
  const json = await fetchJson(url, `search-${countryCode}-${term}`);
  const features = json.features ?? [];
  const regions = features.filter((f) => (f.place_type ?? []).includes('region'));
  if (!regions.length) throw new Error(`no region result for "${term}" (${countryCode})`);
  return regions[0];
}

async function fetchGeometry(maptilerId) {
  const url = `https://api.maptiler.com/geocoding/${maptilerId}.json?key=${KEY}&language=en`;
  const json = await fetchJson(url, maptilerId);
  const feature = (json.features ?? [])[0];
  if (!feature) throw new Error(`no feature for ${maptilerId}`);
  const g = feature.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) {
    throw new Error(`${maptilerId} returned ${g?.type ?? 'no'} geometry, expected a boundary`);
  }
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  // Verbatim coordinates; only ensure rings are closed (MapTiler rings already are).
  return polys
    .map((p) => p.map((ring) => closeRing(ring.map((c) => [c[0], c[1]]))))
    .filter((p) => p[0]?.length >= 4);
}

// ---- geometry helpers ---------------------------------------------------------
function closeRing(ring) {
  if (!ring.length) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  return ring;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

function polygonsArea(polys) {
  let a = 0;
  for (const p of polys) {
    a += ringArea(p[0]);
    for (let i = 1; i < p.length; i++) a -= ringArea(p[i]);
  }
  return a;
}

function bboxOf(polys) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const p of polys) for (const ring of p) for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Even-odd: inside outer ring and outside every hole, like the renderer draws it.
function inPolygons(lng, lat, polys) {
  return polys.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)));
}

function bboxIoU(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 1;
}

// ---- simplification (overview only) ------------------------------------------
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

const OVERVIEW_TOLERANCES = [0.001, 0.002, 0.005, 0.01, 0.02, 0.04, 0.08, 0.16];

// Artifact-safe: a ring is never displaced beyond tolerance and never shrinks
// or grows its area outside [0.75, 1.25]; otherwise the original ring is kept.
function simplifyRingGuarded(ring, minTol) {
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring.slice();
  if (open.length <= 8) return closeRing(open);
  const originalArea = ringArea(ring);
  for (const tol of OVERVIEW_TOLERANCES) {
    if (tol < minTol) continue;
    const simplified = closeRing(simplifyOpen(open, tol));
    if (simplified.length < 4) continue;
    const ratio = ringArea(simplified) / originalArea;
    if (ratio >= 0.75 && ratio <= 1.25) return simplified;
  }
  return closeRing(open);
}

// Escalates tolerance only as far as the point budget requires.
function simplifyPolygonsToBudget(polys) {
  let current = polys;
  for (const tol of OVERVIEW_TOLERANCES) {
    current = polys.map((p) => {
      const outer = simplifyRingGuarded(p[0], tol);
      const holes = p.slice(1).map((h) => simplifyRingGuarded(h, tol)).filter((h) => h.length >= 4);
      return [outer, ...holes];
    });
    if (pointCount(current) <= MAX_OVERVIEW_POINTS) break;
  }
  return current;
}

function pointCount(polys) {
  let n = 0;
  for (const p of polys) for (const ring of p) n += ring.length;
  return n;
}

function ringCount(polys) {
  let n = 0;
  for (const p of polys) n += p.length;
  return n;
}

// ---- reference data (previous asset, for IoU/area evidence) -------------------
let prevBoxes = {};
let prevAreas = {};
try {
  const prev = JSON.parse(readFileSync(PREV_OVERVIEW, 'utf8'));
  for (const f of prev.features) prevBoxes[f.id] = f.properties.bbox;
} catch { /* first build from a clean tree: anchors remain the guard */ }
for (const r of REGIONS) {
  try {
    const d = JSON.parse(readFileSync(`${PREV_DETAIL_DIR}/${r.id}.geojson`, 'utf8'));
    const g = d.features[0].geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    prevAreas[r.id] = polys.reduce((a, p) => a + ringArea(p[0]), 0);
  } catch { /* no detail file */ }
}

// ---- build --------------------------------------------------------------------
const errors = [];
const warnings = [];
const built = [];

for (const region of REGIONS) {
  const term = region.search ?? region.name;
  const hits = [await searchRegion(term, region.countryCode)];
  for (const extra of region.extraSearches ?? []) hits.push(await searchRegion(extra, region.countryCode));

  let polys = [];
  const sourceIds = [];
  const picked = [];
  for (const hit of hits) {
    const geometry = await fetchGeometry(hit.id);
    polys = polys.concat(geometry);
    sourceIds.push(hit.id);
    picked.push({ id: hit.id, text: hit.text, bbox: hit.bbox });
  }

  const points = pointCount(polys);
  const rings = ringCount(polys);
  const holes = polys.reduce((a, p) => a + p.length - 1, 0);
  const bbox = bboxOf(polys);

  if (!polys.length) errors.push(`${region.id}: empty geometry`);
  if (points > MAX_POINTS) errors.push(`${region.id}: ${points} points exceeds cap ${MAX_POINTS}`);
  if (rings > MAX_RINGS) errors.push(`${region.id}: ${rings} rings exceeds cap ${MAX_RINGS}`);

  for (const [aid, lng, lat, label] of ANCHORS) {
    if (aid !== region.id) continue;
    if (!inPolygons(lng, lat, polys)) errors.push(`${region.id}: anchor ${label} (${lng},${lat}) outside geometry`);
  }

  const refBox = prevBoxes[region.id];
  const iou = refBox ? bboxIoU(bbox, refBox) : null;
  if (iou !== null) {
    // Recorded as evidence for every region; enforced only where the shapes are
    // expected to agree. UAE emirates and the merged DNH&DD UT legitimately
    // differ (MapTiler sea envelopes / combined region), so anchors guard those.
    if (!region.skipBboxCheck && iou < 0.5) errors.push(`${region.id}: bbox IoU vs previous asset ${iou.toFixed(2)} < 0.5 (wrong feature?)`);
    else if (!region.skipBboxCheck && iou < 0.8) warnings.push(`${region.id}: bbox IoU vs previous asset ${iou.toFixed(2)}`);
    else if (region.skipBboxCheck && iou < 0.5) warnings.push(`${region.id}: bbox IoU ${iou.toFixed(2)} (shape change accepted)`);
  }

  const area = polygonsArea(polys);
  const refArea = prevAreas[region.id];
  const areaRatio = refArea ? area / refArea : null;

  built.push({ region, polys, sourceIds, picked, points, rings, holes, bbox, iou, area, areaRatio });
  console.log(
    `${region.id.padEnd(6)} ${region.name.padEnd(34)} ${String(points).padStart(7)} pts ${String(rings).padStart(4)} rings ${String(holes).padStart(3)} holes` +
    (iou !== null ? ` iou=${iou.toFixed(2)}` : '') +
    (areaRatio !== null ? ` area×=${areaRatio.toFixed(3)}` : '') +
    ` <- ${sourceIds.join(' + ')}`
  );
}

if (errors.length) {
  console.error('\nVALIDATION FAILED:\n' + errors.map((e) => '  ' + e).join('\n'));
  process.exit(1);
}

// ---- write assets -------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const manifestRegions = {};
const overviewFeatures = [];
const shas = [];

for (const b of built) {
  const { region, polys } = b;
  const feature = {
    type: 'Feature',
    id: region.id,
    properties: {
      id: region.id,
      name: region.name,
      country: region.country,
      countryCode: region.countryCode,
      bbox: b.bbox,
      points: b.points,
      rings: b.rings,
      holes: b.holes,
      sourceIds: b.sourceIds,
      attribution: ATTRIBUTION,
    },
    geometry: polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys },
  };
  const body = JSON.stringify({
    type: 'FeatureCollection',
    name: 'in-ae-admin1',
    source: 'maptiler-geocoding',
    attribution: ATTRIBUTION,
    features: [feature],
  });
  const file = `${OUT_DIR}/${region.id}.geojson`;
  writeFileSync(file, body);
  const sha = createHash('sha256').update(body).digest('hex');
  shas.push(region.id + sha);
  manifestRegions[region.id] = {
    file: `regions/${region.id}.geojson`,
    name: region.name,
    country: region.country,
    countryCode: region.countryCode,
    bbox: b.bbox,
    points: b.points,
    rings: b.rings,
    holes: b.holes,
    sha256: sha,
    sourceIds: b.sourceIds,
    bboxIoU: b.iou,
    areaRatio: b.areaRatio,
  };

  // Overview: simplify, cap rings by area (tiny islands are dropped here only;
  // the canonical file keeps everything).
  let capped = polys;
  if (capped.length > MAX_OVERVIEW_RINGS) {
    capped = capped
      .map((p) => ({ p, area: ringArea(p[0]) }))
      .sort((a, c) => c.area - a.area)
      .slice(0, MAX_OVERVIEW_RINGS)
      .map((x) => x.p);
  }
  const simplified = simplifyPolygonsToBudget(capped);
  overviewFeatures.push({
    type: 'Feature',
    id: region.id,
    properties: {
      id: region.id,
      name: region.name,
      country: region.country,
      countryCode: region.countryCode,
      bbox: bboxOf(simplified),
      points: pointCount(simplified),
      rings: ringCount(simplified),
      sha: sha,
    },
    geometry: simplified.length === 1
      ? { type: 'Polygon', coordinates: simplified[0] }
      : { type: 'MultiPolygon', coordinates: simplified },
  });
}

const version = createHash('sha256').update(shas.join('|')).digest('hex').slice(0, 16);
const manifest = {
  source: 'maptiler-geocoding',
  attribution: ATTRIBUTION,
  generatedAt: new Date().toISOString(),
  version,
  regions: manifestRegions,
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
writeFileSync(OVERVIEW, JSON.stringify({
  type: 'FeatureCollection',
  name: 'in-ae-admin1',
  source: 'maptiler-geocoding',
  attribution: ATTRIBUTION,
  version,
  features: overviewFeatures,
}));

mkdirSync('bench-results', { recursive: true });
writeFileSync(REPORT, JSON.stringify({
  generatedAt: manifest.generatedAt,
  version,
  warnings,
  regions: Object.fromEntries(built.map((b) => [b.region.id, {
    name: b.region.name,
    points: b.points,
    rings: b.rings,
    holes: b.holes,
    bbox: b.bbox,
    bboxIoU: b.iou,
    areaRatio: b.areaRatio,
    sourceIds: b.sourceIds,
    picked: b.picked,
    overviewPoints: overviewFeatures.find((f) => f.id === b.region.id).properties.points,
  }])),
}, null, 2));

const canonBytes = built.reduce((a, b) => a + readFileSync(`${OUT_DIR}/${b.region.id}.geojson`).length, 0);
const overviewBytes = readFileSync(OVERVIEW).length;
console.log(`\nwrote ${built.length} canonical regions to ${OUT_DIR} (${(canonBytes / 1048576).toFixed(1)} MB total)`);
console.log(`wrote ${OVERVIEW} (${(overviewBytes / 1024).toFixed(0)} KB, version ${version})`);
console.log(`wrote ${MANIFEST}`);
if (warnings.length) console.log(`warnings: ${warnings.join('; ')}`);
console.log(`anchor checks passed (${ANCHORS.length})`);
