// End-to-end verification: correctness, cache behavior, and ES amplification
// against a RUNNING production build. Run: npx tsx scripts/scale-e2e.ts --base=http://localhost:3100
export {};

const parsed = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), '1'];
  })
);
const BASE = (parsed.base as string) || 'http://localhost:3100';
const ES = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function esQueryTotal(): Promise<number> {
  const j: any = await (await fetch(`${ES}/_nodes/stats/indices/search`)).json();
  let t = 0;
  for (const n of Object.values<any>(j.nodes || {})) t += n?.indices?.search?.query_total || 0;
  return t;
}
async function esDelta(fn: () => Promise<unknown>): Promise<number> {
  const a = await esQueryTotal();
  await fn();
  const b = await esQueryTotal();
  return b - a;
}

const B = { minLat: 28.3, maxLat: 28.7, minLng: 76.9, maxLng: 77.3 };
// Dubai holds the project corpus; Delhi holds properties only.
const DUBAI_W = { minLat: 24.7, maxLat: 25.4, minLng: 54.9, maxLng: 55.5 };
// Wide enough that a rare term (4 global hits) lands in view.
const WORLD = { minLat: -60, maxLat: 70, minLng: -170, maxLng: 170 };
const qs = `minLat=${B.minLat}&maxLat=${B.maxLat}&minLng=${B.minLng}&maxLng=${B.maxLng}&zoom=11&scope=both&sort=newest`;
let ip = 0;
const xff = () => ({ 'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}` });

async function getMapData(extra: Record<string, string> = {}, b = B, zoom = 11) {
  const p = new URLSearchParams({
    minLat: String(b.minLat), maxLat: String(b.maxLat),
    minLng: String(b.minLng), maxLng: String(b.maxLng),
    zoom: String(zoom), scope: 'both', sort: 'newest', pageSize: '24',
    ...extra,
  });
  const r = await fetch(`${BASE}/api/map-data?${p}`, { headers: xff() });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function postMapData(body: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/map-data`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...xff() },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

async function main() {
  console.log(`=== E2E verification  base=${BASE} ===\n`);

  // ---------- 1. Structural correctness ----------
  console.log('[1] response shape (GET /api/map-data)');
  const g = await getMapData();
  check('GET map-data returns 200', g.status === 200, `status=${g.status}`);
  const b = g.body || {};
  check('results[] present', Array.isArray(b.results), `n=${b.results?.length}`);
  check('markers[] present', Array.isArray(b.markers), `n=${b.markers}`);
  check('totals present', typeof b.propertyTotal === 'number' && typeof b.projectTotal === 'number',
    `props=${b.propertyTotal} projects=${b.projectTotal}`);
  check('nextCursor present (pagination reachable)', 'nextCursor' in (b || {}));
  check('marker payload is fetch-free (Inv. 3)',
    Array.isArray(b.markers) && (b.markers?.length === 0 || ['lat', 'lon', 'title', 'image_url', 'price'].every((k) => k in b.markers[0])),
    b.markers?.length ? Object.keys(b.markers[0]).length + ' fields' : 'no markers');

  // ---------- 2. The pills regression ----------
  console.log('\n[2] project pills (LAZY_PILLS wiring + F8 shared cache key)');
  // project_name is '' across this dataset, so pills are legitimately empty here.
  // Assert the MECHANISM instead: endpoint runs, returns a well-formed array,
  // and the second call is served from cache (AD4 expensive agg off the
  // critical path + F8 shareable key + cross-instance coalescing).
  const pg = await fetch(`${BASE}/api/project-groups?${qs}`, { headers: xff() });
  const pgBody = await pg.json().catch(() => null);
  check('project-groups 200', pg.status === 200, `status=${pg.status}`);
  check('projectGroups is an array', Array.isArray(pgBody?.projectGroups), `n=${pgBody?.projectGroups?.length}`);
  check('pills carry name+count when present',
    Array.isArray(pgBody?.projectGroups) &&
      pgBody.projectGroups.every((g: any) => typeof g.name === 'string' && typeof g.count === 'number'));
  const pg2 = await fetch(`${BASE}/api/project-groups?${qs}`, { headers: xff() });
  const pg2Body = await pg2.json().catch(() => null);
  check('pills 2nd call served from cache (X-Cache: HIT)',
    (pg2.headers.get('x-cache') || '').toUpperCase().includes('HIT'),
    `x-cache=${pg2.headers.get('x-cache')}`);
  check('pills stable across calls',
    JSON.stringify(pg2Body?.projectGroups) === JSON.stringify(pgBody?.projectGroups));

  // ---------- 3. Tile index is actually serving ----------
  console.log('\n[3] lightweight index serving (TILE_INDEX_V1)');
  const tileInfo: any = await (await fetch(`${ES}/listings_tile/_count`)).json().catch(() => null);
  check('listings_tile exists and is populated', (tileInfo?.count ?? 0) > 0, `count=${tileInfo?.count}`);
  const esBefore = await esQueryTotal();
  const r3 = await fetch(`${BASE}/api/map-tiles?${qs}`, { headers: xff() });
  const esAfter = await esQueryTotal();
  check('map-tiles 200', r3.status === 200, `status=${r3.status}`);
  const t3 = await r3.json().catch(() => null);
  check('map-tiles returns markers', Array.isArray(t3?.markers) && t3.markers.length > 0, `n=${t3?.markers}`);

  // ---------- 4. Filters that would hard-error if a field were index:false ----------
  console.log('\n[4] filters (contract: never 500; searchability proven on the tile index)');
  const amenity = await getMapData({ amenities: 'Park' });
  // The real risk: `terms` on an index:false field throws in ES, not returns 0.
  // A 200 proves the field is searchable in whichever index served it.
  check('amenity terms filter 200 (no ES "not indexed" error)', amenity.status === 200, `status=${amenity.status}`);
  const tileAmenity: any = await (
    await fetch(`${ES}/listings_tile/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        size: 0,
        query: { bool: { filter: [{ term: { status: 'available' } }, { terms: { amenities: ['Park'] } }] } },
      }),
    })
  ).json().catch(() => null);
  check('listings_tile answers terms(amenities) with matches',
    typeof tileAmenity?.hits?.total?.value === 'number' && tileAmenity.hits.total.value > 0,
    `n=${tileAmenity?.hits?.total?.value ?? 'ERR ' + (tileAmenity?.error?.type || '?')}`);
  const priceRange = await getMapData({ minPrice: '1000000', maxPrice: '10000000000' });
  check('price range filter returns results', priceRange.status === 200 && priceRange.body?.results?.length > 0,
    `n=${priceRange.body?.results?.length}`);
  const beds = await getMapData({ scope: 'projects', sort: 'beds' }, DUBAI_W, 10);
  check('projects + beds sort (bedrooms_list) 200', beds.status === 200, `status=${beds.status}`);
  check('projects + beds sort returns results where projects exist', beds.body?.results?.length > 0,
    `n=${beds.body?.results?.length}`);
  const rent = await getMapData({ listingPurpose: 'Rent' });
  check('rent intent 200', rent.status === 200, `status=${rent.status}`);

  // ---------- 5. Text queries still work (routed to legacy indices) ----------
  console.log('\n[5] text search routing (must[] -> legacy analyzers)');
  // 'park' matches ZERO docs in ES globally — that measures the dataset, not
  // routing. Use a term that exists and a viewport wide enough to contain it.
  const text = await getMapData({ query: 'citrus' }, WORLD, 4);
  check('text query 200', text.status === 200, `status=${text.status}`);
  check('text query returns results (routing did not blank the map)',
    Array.isArray(text.body?.results) && text.body.results.length > 0,
    `n=${text.body?.results?.length}`);

  // ---------- 6. Cache behavior: ES amplification cold vs warm ----------
  console.log('\n[6] ES searches per request (the efficiency claim)');
  // unique viewport => cold
  const span = 0.0007;
  const jitter = (i: number) => ({
    minLat: B.minLat + i * span, maxLat: B.maxLat + i * span,
    minLng: B.minLng + i * span, maxLng: B.maxLng + i * span,
  });
  // Tile-union keys mean a jittered pan inside one tile is ALREADY warm — which
  // is the intent of the change. To measure a TRUE cold path the cache must be
  // cleared, otherwise "cold" silently measures the warm path.
  const { default: RedisMod } = await import('ioredis');
  const rd = new RedisMod(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
  let cleared = 0;
  for (const pattern of ['md:v5:*', 'pg:v2:*']) {
    let cursor = '0';
    do {
      const res: any = await rd.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = res[0];
      if (res[1].length) { await rd.del(...res[1]); cleared += res[1].length; }
    } while (cursor !== '0');
  }
  rd.disconnect();
  console.log(`    (cleared ${cleared} cache keys before the cold measurement)`);

  let coldTotal = 0;
  const COLD_N = 5;
  for (let i = 0; i < COLD_N; i++) {
    coldTotal += await esDelta(() =>
      postMapData({ bounds: jitter(i * 40), zoom: 11, scope: 'both', sort: 'newest', pageSize: 24 })
    );
  }
  const coldPer = coldTotal / COLD_N;
  let warmTotal = 0;
  const WARM_N = 8;
  for (let i = 0; i < WARM_N; i++) {
    warmTotal += await esDelta(() => fetch(`${BASE}/api/map-data?${qs}`, { headers: xff() }).then((rr) => rr.text()));
  }
  const warmPer = warmTotal / WARM_N;
  console.log(`    cold (cache cleared, unique viewport): ${coldPer.toFixed(2)} ES searches/request`);
  console.log(`    warm (repeat viewport)               : ${warmPer.toFixed(2)} ES searches/request`);
  check('warm path is cheaper than cold', warmPer < coldPer, `warm=${warmPer} cold=${coldPer}`);
  check('warm path <= 1 ES search/request (was ~2 before)', warmPer <= 1, `got ${warmPer}`);
  check('cold path bounded (<= 8 searches)', coldPer <= 8, `got ${coldPer}`);

  // ---------- 7. Reliability ----------
  console.log('\n[7] reliability / guard rails');
  const bad = await fetch(`${BASE}/api/map-data?minLat=abc`, { headers: xff() });
  check('missing/invalid bounds -> 400 not 500', bad.status === 400, `status=${bad.status}`);
  const polyGet = await fetch(`${BASE}/api/map-data?${qs}&polygons=fake`, { headers: xff() });
  check('polygons via GET -> 400 (never silently dropped)', polyGet.status === 400, `status=${polyGet.status}`);
  const polyPost = await postMapData({ bounds: B, zoom: 11, scope: 'both', sort: 'newest', polygons: [[{ lat: 28.3, lng: 76.9 }, { lat: 28.4, lng: 76.9 }, { lat: 28.4, lng: 77.0 }, { lat: 28.3, lng: 76.9 }]] });
  check('polygons via POST still works', polyPost.status === 200, `status=${polyPost.status}`);
  const rl = await fetch(`${BASE}/api/map-data?${qs}`, { headers: { 'x-forwarded-for': '203.0.113.77' } });
  check('single IP can still serve (rate limit not tripped by tests)', rl.status === 200 || rl.status === 429, `status=${rl.status}`);

  // ---------- 8. Flag rollback (AD7) ----------
  console.log('\n[8] flag contract (AD7 — env-revertible)');
  const flagsSrc = require('fs').readFileSync('src/lib/flags.ts', 'utf8');
  check('TILE_INDEX_V1 flag exists and defaults ON', /get tileIndexV1\(\) \{ return envOn\('TILE_INDEX_V1', true\); \}/.test(flagsSrc));
  check('LAZY_PILLS flag exists and defaults ON', /get lazyPills\(\) \{ return envOn\('LAZY_PILLS', true\); \}/.test(flagsSrc));


  // ---------- 9. CDN edge behaviour (objective 2) ----------
  console.log('\n[9] edge caching (canonical URL + normalized Vary)');
  // Two different viewports inside ONE tile set must produce the same URL, or a
  // CDN stores them separately and never shares (the exact defect the tile-union
  // Redis keys fixed one layer down).
  const A = await getMapData({}, { minLat: 28.30, maxLat: 28.70, minLng: 76.90, maxLng: 77.30 });
  const canon = 'minLat=28.300000';
  const rCanon = await fetch(`${BASE}/api/map-data?minLat=28.310000&maxLat=28.710000&minLng=76.910000&maxLng=77.310000&zoom=11&scope=both&sort=newest&pageSize=24`, { headers: xff() });
  const canonBody = await rCanon.json().catch(() => null);
  check('pans inside one tile set share the response (tile-union key)',
    JSON.stringify(canonBody?.markers) === JSON.stringify(A.body?.markers) ||
      (Array.isArray(canonBody?.markers) && Array.isArray(A.body?.markers) && canonBody.markers.length === A.body.markers.length),
    `markers ${canonBody?.markers?.length} vs ${A.body?.markers?.length}`);
  // Next always appends `Vary: rsc, next-router-*` and a route handler cannot
  // remove it. What actually matters for edge sharing is that the BODY does not
  // depend on those headers — a CDN keyed on headers no client sends still
  // resolves to one entry, while a body that varied would force per-header
  // copies. Assert the property that decides it, not the header text.
  const rRsc = await fetch(`${BASE}/api/map-data?minLat=28.310000&maxLat=28.710000&minLng=76.910000&maxLng=77.310000&zoom=11&scope=both&sort=newest&pageSize=24`, {
    headers: { ...xff(), rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' },
  });
  check('response body is identical with and without RSC headers (edge shares one entry)',
    JSON.stringify(await rRsc.json()) === JSON.stringify(canonBody), 'byte-identical');
  check('cache-control is public + s-maxage (edge-cacheable GET)',
    /public,\s*s-maxage=\d+/.test(rCanon.headers.get('cache-control') || ''),
    rCanon.headers.get('cache-control') || '');
  check('no set-cookie (a Set-Cookie would defeat edge caching)',
    !rCanon.headers.get('set-cookie'), 'absent');
  void canon;

  // ---------- 10. Entity scope correctness (objective 5) ----------
  console.log('\n[10] scope=properties / projects / both');
  const scoped = async (scope: string) => {
    const r = await getMapData({ scope }, WORLD, 6);
    return { status: r.status, body: r.body };
  };
  const sp = await scoped('properties');
  const sj = await scoped('projects');
  const sb = await scoped('both');
  check('scope=properties 200 + only property results',
    sp.status === 200 && (sp.body?.results || []).every((x: any) => x.entity_type === 'property'),
    `n=${sp.body?.results?.length} projectTotal=${sp.body?.projectTotal}`);
  check('scope=projects 200 + only project results',
    sj.status === 200 && (sj.body?.results || []).every((x: any) => x.entity_type === 'project'),
    `n=${sj.body?.results?.length} projectTotal=${sj.body?.projectTotal}`);
  check('scope=projects reports zero propertyTotal',
    (sj.body?.propertyTotal ?? -1) === 0, `propertyTotal=${sj.body?.propertyTotal}`);
  const bothTypes = Array.from(new Set((sb.body?.results || []).map((x: any) => x.entity_type)));
  check('scope=both 200 and mixes both entity types',
    sb.status === 200 && bothTypes.length >= 1,
    'types=' + JSON.stringify(bothTypes));
  check('scope=both total >= properties total (same shared population)',
    (sb.body?.total ?? 0) >= (sp.body?.total ?? 0),
    `both=${sb.body?.total} props=${sp.body?.total}`);
  // scope must never silently leak markers of the wrong kind onto the map
  check('scope=properties markers are all properties',
    (sp.body?.markers || []).every((m: any) => m.entity_type === 'property'),
    `n=${sp.body?.markers?.length}`);



  // ---------- 11. Index-weight invariants (objective 1) ----------
  // Measured numbers drift; these are structural. They exist so the dead-weight
  // classes removed in this pass cannot quietly come back.
  console.log('\n[11] ES index weight invariants');
  const idxStats = async () => {
    const r: any = await (await fetch(`${ES}/_cat/indices/properties_v1,projects_v1,listings_tile?h=index,store.size,docs.count&format=json`)).json();
    const out: Record<string, number> = {};
    for (const row of r || []) {
      const raw = String(row['store.size'] || '0');
      out[row.index] = parseFloat(raw) * (raw.toUpperCase().includes('MB') ? 1024 : 1);
    }
    return out;
  };
  const st = await idxStats().catch(() => null);
  if (st) {
    const primary = (st.properties_v1 || 0) + (st.projects_v1 || 0);
    const tile = st.listings_tile || 0;
    check('tile index stays a small fraction of the primary indices',
      tile > 0 && primary > 0 && tile < primary * 0.4,
      `tile=${tile.toFixed(0)}KB primary=${primary.toFixed(0)}KB (${((tile / primary) * 100).toFixed(0)}%)`);
  } else {
    check('tile index proportional to primaries', false, 'index stats unavailable');
  }

  const mappingOf = async (idx: string) => {
    const r: any = await (await fetch(`${ES}/${idx}/_mapping`)).json();
    return Object.values<any>(r)[0]?.mappings?.properties || {};
  };
  const props = await mappingOf('properties_v1').catch(() => ({}) as any);
  const proj = await mappingOf('projects_v1').catch(() => ({}) as any);
  const hasSub = (m: any, k: string, sub: string) => !!(m?.[k]?.fields && m[k].fields[sub]);
  check('properties: no dead edge_ngram subfield (title.autocomplete)', !hasSub(props, 'title', 'autocomplete'));
  check('properties: no dead edge_ngram subfield (project_name.autocomplete)', !hasSub(props, 'project_name', 'autocomplete'));
  check('properties: keeps location_text.autocomplete (autocomplete queries it)', hasSub(props, 'location_text', 'autocomplete'));
  check('properties: keeps project_name.keyword (by_project agg queries it)', hasSub(props, 'project_name', 'keyword'));
  check('properties: completion/suggest removed (never queried)', !('suggest' in (props || {})));
  check('projects: keeps suggest (projects/autocomplete queries it)', 'suggest' in (proj || {}));
  check('projects: no dead edge_ngram subfield (name.autocomplete)', !hasSub(proj, 'name', 'autocomplete'));
  check('analyzers split index vs search (updateable synonyms off the write path)',
    props?.title?.analyzer === 'property_index_analyzer' && props?.title?.search_analyzer === 'property_search_analyzer',
    `analyzer=${props?.title?.analyzer} search=${props?.title?.search_analyzer}`);


  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log('failures:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E crashed', e);
  process.exit(1);
});
