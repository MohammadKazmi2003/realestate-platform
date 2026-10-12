// Browse action-matrix + concurrency load harness.
//
// Modes:
//   actions  — one request per user action (cold) then warm repeats; records
//              wall latency, ES shard-query deltas, X-Cache, Server-Timing phases.
//   load     — concurrency ladder for warm/subtile/crosstile/unique scenarios,
//              with during-load sampling of ES thread pool / CPU / heap, the
//              app process CPU/RSS, and Redis op stats.
//
// Usage:
//   npx tsx scripts/bench-browse-actions.ts actions --base=http://localhost:3200 --label=live --n=50
//   npx tsx scripts/bench-browse-actions.ts load --base=http://localhost:3200 --label=100k \
//     --scenario=warm --conc=1,10,25,50 --n=100
//
// Every request carries a distinct x-forwarded-for unless --same-ip is passed
// (the map limiter is 60/min/IP; distinct IPs keep the limiter out of the way).
import 'dotenv/config';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import Redis from 'ioredis';
import { coveringTileUnionBounds } from '@/lib/mapTiles';

const argv = process.argv.slice(2);
const MODE = argv[0] === 'load' ? 'load' : 'actions';
const args = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const BASE = String(args.base || 'http://localhost:3200');
const LABEL = String(args.label || 'live');
const N = Number(args.n || 50);
const SAME_IP = args['same-ip'] === 'true';
const ES = String(args.es || process.env.ELASTICSEARCH_URL || 'http://localhost:9200');
const OUT_DIR = 'bench-results';
const APP_PORT = Number(new URL(BASE).port || 3000);

const DELHI = { minLat: 28.30, maxLat: 28.80, minLng: 76.90, maxLng: 77.50 };
const DUBAI = { minLat: 24.95, maxLat: 25.45, minLng: 55.05, maxLng: 55.55 };
const COUNTRY = { minLat: 8.0, maxLat: 35.0, minLng: 54.0, maxLng: 97.0 };

let ipCounter = 0;
function nextIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function mapDataUrl(
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  zoom: number,
  extra: Record<string, string | number | undefined> = {}
): string {
  const c = coveringTileUnionBounds(bounds, zoom);
  const qp = new URLSearchParams({
    minLat: c.minLat.toFixed(6),
    maxLat: c.maxLat.toFixed(6),
    minLng: c.minLng.toFixed(6),
    maxLng: c.maxLng.toFixed(6),
    zoom: String(zoom),
    scope: 'both',
    sort: 'newest',
    pageSize: '24',
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') qp.set(k, String(v));
  }
  return `${BASE}/api/map-data?${qp.toString()}`;
}

function groupsUrl(bounds: typeof DELHI, zoom: number, extra: Record<string, any> = {}): string {
  const c = coveringTileUnionBounds(bounds, zoom);
  const qp = new URLSearchParams({
    minLat: c.minLat.toFixed(6), maxLat: c.maxLat.toFixed(6),
    minLng: c.minLng.toFixed(6), maxLng: c.maxLng.toFixed(6),
    zoom: String(zoom), scope: 'both', sort: 'newest',
  });
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') qp.set(k, String(v));
  return `${BASE}/api/project-groups?${qp.toString()}`;
}

// ---- ES stat helpers -------------------------------------------------------------

async function esQueryTotal(): Promise<number> {
  const r = await fetch(`${ES}/_nodes/stats/indices/search`);
  const j: any = await r.json();
  let t = 0;
  for (const n of Object.values<any>(j.nodes || {})) t += n.indices?.search?.query_total || 0;
  return t;
}

async function esSample(): Promise<any> {
  const r = await fetch(`${ES}/_nodes/stats/os,jvm,thread_pool,indices?filter_path=nodes.*.os.cpu.percent,nodes.*.jvm.mem.heap_used_in_bytes,nodes.*.jvm.mem.heap_max_in_bytes,nodes.*.thread_pool.search.active,nodes.*.thread_pool.search.queue,nodes.*.thread_pool.search.rejected,nodes.*.thread_pool.search.threads,nodes.*.indices.search.query_total,nodes.*.indices.search.fetch_total`);
  const j: any = await r.json();
  const out: any = { searchActive: 0, searchQueue: 0, searchRejected: 0, searchThreads: 0, cpu: 0, heapUsed: 0, heapMax: 0, queryTotal: 0, fetchTotal: 0 };
  for (const n of Object.values<any>(j.nodes || {})) {
    out.searchActive = Math.max(out.searchActive, n.thread_pool?.search?.active || 0);
    out.searchQueue = Math.max(out.searchQueue, n.thread_pool?.search?.queue || 0);
    out.searchRejected = Math.max(out.searchRejected, n.thread_pool?.search?.rejected || 0);
    out.searchThreads = Math.max(out.searchThreads, n.thread_pool?.search?.threads || 0);
    out.cpu = Math.max(out.cpu, n.os?.cpu?.percent || 0);
    out.heapUsed = Math.max(out.heapUsed, n.jvm?.mem?.heap_used_in_bytes || 0);
    out.heapMax = Math.max(out.heapMax, n.jvm?.mem?.heap_max_in_bytes || 0);
    out.queryTotal += n.indices?.search?.query_total || 0;
    out.fetchTotal += n.indices?.search?.fetch_total || 0;
  }
  return out;
}

function appPid(): number | null {
  try {
    const out = execSync(`lsof -nP -iTCP:${APP_PORT} -sTCP:LISTEN -t 2>/dev/null | head -1`).toString().trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

function appSample(pid: number | null): { cpu: number; rssKb: number } {
  if (!pid) return { cpu: 0, rssKb: 0 };
  try {
    const out = execSync(`ps -o %cpu=,rss= -p ${pid}`).toString().trim().split(/\s+/);
    return { cpu: Number(out[0]) || 0, rssKb: Number(out[1]) || 0 };
  } catch {
    return { cpu: 0, rssKb: 0 };
  }
}

// ---- request execution -----------------------------------------------------------

type ReqResult = {
  wallMs: number;
  status: number;
  cache: string;
  esTook: string;
  timing: Record<string, number>;
  bytes: number;
  esQueries: number;
  error?: string;
  body?: any;
};

async function doRequest(url: string, init: RequestInit = {}): Promise<ReqResult> {
  const headers: any = { ...(init.headers || {}), 'x-forwarded-for': SAME_IP ? '10.0.0.1' : nextIp() };
  const t0 = performance.now();
  let res: Response | null = null;
  let bodyText = '';
  let error: string | undefined;
  try {
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20000) });
    bodyText = await res.text();
  } catch (e: any) {
    error = e?.message || String(e);
  }
  const wallMs = performance.now() - t0;
  const esQueries = 0; // filled in per-action / per-level deltas
  const timing: Record<string, number> = {};
  const st = res?.headers.get('server-timing') || '';
  for (const part of st.split(',')) {
    const m = part.trim().match(/^([\w-]+);dur=([\d.]+)/);
    if (m) timing[m[1]] = Number(m[2]);
  }
  let body: any;
  if (MODE === 'actions' && bodyText) {
    try { body = JSON.parse(bodyText); } catch { /* not json */ }
  }
  return {
    wallMs,
    status: res?.status || 0,
    cache: res?.headers.get('x-cache') || '',
    esTook: res?.headers.get('x-es-took') || '',
    timing,
    bytes: bodyText.length,
    esQueries,
    error,
    body,
  };
}

// ---- action definitions ----------------------------------------------------------

type Action = { name: string; description: string; request: () => Promise<ReqResult> | ReqResult };

function buildActions(): Action[] {
  const actions: Action[] = [];
  const get = (url: string) => () => doRequest(url);

  actions.push({ name: 'map_initial_delhi_z11', description: 'fresh map load, Delhi z11, Buy intent', request: get(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell' })) });
  actions.push({ name: 'map_subtile_pan', description: 'tiny pan within same tile union', request: get(mapDataUrl({ ...DELHI, minLat: DELHI.minLat + 0.005, maxLat: DELHI.maxLat + 0.005 }, 11, { listingPurpose: 'Sell' })) });
  actions.push({ name: 'map_crosstile_pan', description: 'pan to a different tile union', request: get(mapDataUrl({ ...DELHI, minLng: DELHI.minLng + 1.0, maxLng: DELHI.maxLng + 1.0 }, 11, { listingPurpose: 'Sell' })) });
  actions.push({ name: 'map_zoom_out_z8', description: 'zoom out to z8', request: get(mapDataUrl({ minLat: 27.5, maxLat: 29.5, minLng: 75.5, maxLng: 78.5 }, 8, { listingPurpose: 'Sell' })) });
  actions.push({ name: 'map_country_z4', description: 'country overview z4', request: get(mapDataUrl(COUNTRY, 4, { listingPurpose: 'Sell' })) });
  actions.push({ name: 'map_filter_price', description: 'price filter applied', request: get(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell', minPrice: 5000000, maxPrice: 20000000 })) });
  actions.push({ name: 'map_filter_bhk', description: 'BHK filter applied', request: get(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell', bhkType: '3 BHK' })) });
  actions.push({ name: 'map_filter_type', description: 'property type filter applied', request: get(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell', propertyType: 'Residential Apartment' })) });
  actions.push({ name: 'map_sort_price_desc', description: 'sort price high-low', request: get(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell', sort: 'price_desc' })) });
  actions.push({ name: 'map_sort_beds', description: 'sort by bedrooms', request: get(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell', sort: 'beds' })) });
  actions.push({ name: 'project_groups', description: 'right-rail community pills', request: get(groupsUrl(DELHI, 11, { listingPurpose: 'Sell' })) });
  actions.push({ name: 'autocomplete_dub', description: 'location autocomplete (ES + MapTiler)', request: get(`${BASE}/api/search/autocomplete?q=dub&scope=both`) });

  // Load More needs a real cursor from page 1; resolve lazily once.
  let cursor: any[] | null = null;
  actions.push({
    name: 'load_more_page2',
    description: 'Load More via /api/search with cursor',
    request: async () => {
      if (!cursor) {
        const first = await doRequest(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell' }));
        cursor = first.body?.nextCursor ?? null;
      }
      return doRequest(`${BASE}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'both', sort: 'newest', pageSize: 24, listingPurpose: 'Sell', cursor }),
      });
    },
  });

  // Marker click = listing detail fetch (Supabase; no ES query expected).
  let listingId: string | null = null;
  actions.push({
    name: 'marker_click_listing',
    description: 'marker click -> /api/listings/{id}',
    request: async () => {
      if (!listingId) {
        const first = await doRequest(mapDataUrl(DELHI, 11, { listingPurpose: 'Sell' }));
        listingId = first.body?.results?.[0]?.id ?? null;
      }
      if (!listingId) return { wallMs: 0, status: 0, cache: '', esTook: '', timing: {}, bytes: 0, esQueries: 0, error: 'no listing id (empty result)' };
      return doRequest(`${BASE}/api/listings/${listingId}`);
    },
  });

  return actions;
}

// ---- stats -----------------------------------------------------------------------

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(runs: ReqResult[]) {
  const walls = runs.map((r) => r.wallMs).sort((a, b) => a - b);
  const errs = runs.filter((r) => r.status >= 400 || r.error).length;
  const hits = runs.filter((r) => r.cache.includes('list:HIT')).length;
  const esQ = runs.map((r) => r.esQueries);
  const phaseKeys = new Set<string>();
  for (const r of runs) for (const k of Object.keys(r.timing)) phaseKeys.add(k);
  const phases: Record<string, number> = {};
  for (const k of phaseKeys) {
    const vals = runs.map((r) => r.timing[k]).filter((v) => v != null).sort((a, b) => a - b);
    if (vals.length) phases[k] = pct(vals, 50);
  }
  return {
    n: runs.length,
    errPct: (errs / runs.length) * 100,
    cacheHitPct: (hits / runs.length) * 100,
    esPerReqAvg: esQ.reduce((a, b) => a + b, 0) / runs.length,
    p50: Math.round(pct(walls, 50)),
    p95: Math.round(pct(walls, 95)),
    p99: Math.round(pct(walls, 99)),
    max: Math.round(walls[walls.length - 1] || 0),
    medianBytes: pct(runs.map((r) => r.bytes).sort((a, b) => a - b), 50),
    phaseP50: phases,
  };
}

// ---- actions mode ----------------------------------------------------------------

async function runActions() {
  console.log(`# actions corpus=${LABEL} warmN=${N} base=${BASE}`);
  const actions = buildActions();
  const out: any = { label: LABEL, base: BASE, actions: {} };
  for (const action of actions) {
    const runs: ReqResult[] = [];
    // ES shard-query deltas per action, not per request: _nodes/stats can block
    // for seconds while the cluster is under load, which would dominate timing.
    const q0 = await esQueryTotal();
    try {
      runs.push(await action.request());
    } catch (e: any) {
      runs.push({ wallMs: 0, status: 0, cache: '', esTook: '', timing: {}, bytes: 0, esQueries: 0, error: String(e?.message || e) });
    }
    const q1 = await esQueryTotal();
    for (let i = 0; i < N; i++) {
      try {
        runs.push(await action.request());
      } catch (e: any) {
        runs.push({ wallMs: 0, status: 0, cache: '', esTook: '', timing: {}, bytes: 0, esQueries: 0, error: String(e?.message || e) });
      }
    }
    const q2 = await esQueryTotal();
    const cold = runs[0];
    cold.esQueries = q1 - q0;
    const warm = runs.slice(1);
    const warmEs = (q2 - q1) / Math.max(1, warm.length);
    for (const r of warm) r.esQueries = warmEs;
    out.actions[action.name] = {
      description: action.description,
      cold: { wallMs: Math.round(cold.wallMs), status: cold.status, cache: cold.cache, esQueries: cold.esQueries, timing: cold.timing, bytes: cold.bytes, error: cold.error },
      warm: summarize(warm),
    };
    const w = out.actions[action.name].warm;
    console.log(`${action.name.padEnd(24)} cold=${String(Math.round(cold.wallMs)).padStart(6)}ms es=${cold.esQueries} ${cold.cache || '-'} | warm p50=${w.p50} p95=${w.p95} p99=${w.p99} hit=${w.cacheHitPct.toFixed(0)}% es/req=${w.esPerReqAvg.toFixed(2)} bytes=${w.medianBytes}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/actions-${LABEL}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`# wrote ${file}`);
}

// ---- load mode -------------------------------------------------------------------

type Scenario = 'warm' | 'subtile' | 'crosstile' | 'unique';

function scenarioRequest(scenario: Scenario, idx: number): { url: string; init?: RequestInit } {
  if (scenario === 'warm') return { url: mapDataUrl(DELHI, 11, { listingPurpose: 'Sell' }) };
  if (scenario === 'subtile') {
    const d = (idx % 20) * 0.001;
    return { url: mapDataUrl({ ...DELHI, minLat: DELHI.minLat + d, maxLat: DELHI.maxLat + d }, 11, { listingPurpose: 'Sell' }) };
  }
  const rnd = (seed: number) => {
    const x = Math.sin(seed * 9301 + 49297) * 233280;
    return x - Math.floor(x);
  };
  if (scenario === 'crosstile') {
    // City-scale pans at random India locations: every request a distinct
    // tile union (true cross-tile cold), z11.
    const lat = 8 + rnd(idx * 5) * 25;
    const lng = 68 + rnd(idx * 5 + 1) * 22;
    return { url: mapDataUrl({ minLat: lat, maxLat: lat + 0.5, minLng: lng, maxLng: lng + 0.5 }, 11, { listingPurpose: 'Sell' }) };
  }
  // unique: random India viewport, zoom 6-13 (worst-case cold)
  const lat = 8 + rnd(idx * 3) * 25;
  const lng = 68 + rnd(idx * 3 + 1) * 22;
  const zoom = 6 + Math.floor(rnd(idx * 3 + 2) * 8);
  const span = 0.05 + rnd(idx * 7) * 0.7;
  return { url: mapDataUrl({ minLat: lat, maxLat: lat + span, minLng: lng, maxLng: lng + span }, zoom) };
}

async function runLoad() {
  const scenario = String(args.scenario || 'warm') as Scenario;
  const concs = String(args.conc || '1,10,25,50').split(',').map(Number);
  const pid = appPid();
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect().catch(() => {});
  console.log(`# load corpus=${LABEL} scenario=${scenario} conc=${concs.join(',')} n=${N} appPid=${pid ?? '?'}`);

  const out: any = { label: LABEL, scenario, levels: [] };

  let levelIdx = 0;
  for (const conc of concs) {
    const levelOffset = levelIdx * 100000;
    levelIdx++;
    // reset redis stat baseline
    let redisStats0: any = {};
    try {
      const info = await redis.info('stats');
      redisStats0 = parseRedisInfo(info);
    } catch { /* redis unavailable */ }

    const samples: any[] = [];
    let stop = false;
    const sampleLoop = (async () => {
      while (!stop) {
        try {
          const [es, app] = await Promise.all([esSample(), Promise.resolve(appSample(pid))]);
          samples.push({ t: Date.now(), ...es, appCpu: app.cpu, appRssKb: app.rssKb });
        } catch { /* ES transient */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    const qBefore = await esQueryTotal();
    const t0 = performance.now();
    const results: ReqResult[] = new Array(N);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= N) return;
        // Offset per level so each concurrency level gets fresh viewports for
        // crosstile/unique (otherwise levels 2+ replay level 1's warmed URLs).
        const { url, init } = scenarioRequest(scenario, i + levelOffset);
        try {
          results[i] = await doRequest(url, init);
        } catch (e: any) {
          results[i] = { wallMs: 0, status: 0, cache: '', esTook: '', timing: {}, bytes: 0, esQueries: 0, error: String(e?.message || e) };
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    const wallSec = (performance.now() - t0) / 1000;
    const qAfter = await esQueryTotal();
    stop = true;
    await sampleLoop;

    let redisStats1: any = {};
    try {
      const info = await redis.info('stats');
      redisStats1 = parseRedisInfo(info);
    } catch { /* redis unavailable */ }

    const walls = results.map((r) => r.wallMs).sort((a, b) => a - b);
    const errs = results.filter((r) => r.status >= 400 || r.error).length;
    const hits = results.filter((r) => r.cache.includes('list:HIT')).length;
    const level = {
      conc,
      requests: N,
      wallSec: Number(wallSec.toFixed(2)),
      qps: Number((N / wallSec).toFixed(1)),
      p50: Math.round(pct(walls, 50)),
      p95: Math.round(pct(walls, 95)),
      p99: Math.round(pct(walls, 99)),
      errPct: Number(((errs / N) * 100).toFixed(2)),
      cacheHitPct: Number(((hits / N) * 100).toFixed(1)),
      esPerReq: Number(((qAfter - qBefore) / N).toFixed(3)),
      samples: summarizeSamples(samples),
      redis: {
        opsPerSec: Number(redisStats1.instantaneous_ops_per_sec || 0),
        keyspaceHitsDelta: (redisStats1.keyspace_hits || 0) - (redisStats0.keyspace_hits || 0),
        keyspaceMissesDelta: (redisStats1.keyspace_misses || 0) - (redisStats0.keyspace_misses || 0),
      },
    };
    out.levels.push(level);
    console.log(`conc=${String(conc).padStart(3)} qps=${level.qps} p50=${level.p50} p95=${level.p95} p99=${level.p99} err=${level.errPct}% hit=${level.cacheHitPct}% es/req=${level.esPerReq} | esQueueMax=${level.samples.searchQueueMax} rejected=${level.samples.searchRejectedDelta} esCpuMax=${level.samples.cpuMax}% heapMax=${level.samples.heapUsedMaxMB}MB appCpuMax=${level.samples.appCpuMax}% appRssMax=${level.samples.appRssMaxMB}MB`);
  }

  try { redis.disconnect(); } catch { /* noop */ }
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/load-${LABEL}-${scenario}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`# wrote ${file}`);
}

function parseRedisInfo(info: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of info.split('\n')) {
    const m = line.replace('\r', '').match(/^([\w_]+):(-?\d+(?:\.\d+)?)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function summarizeSamples(samples: any[]) {
  const pick = (key: string, agg: 'max' | 'delta' = 'max') => {
    if (!samples.length) return 0;
    if (agg === 'max') return Number(Math.max(...samples.map((s) => s[key] || 0)).toFixed(2));
    return samples[samples.length - 1][key] - samples[0][key];
  };
  return {
    count: samples.length,
    searchActiveMax: pick('searchActive'),
    searchQueueMax: pick('searchQueue'),
    searchRejectedDelta: pick('searchRejected', 'delta'),
    searchThreads: samples.length ? samples[0].searchThreads : 0,
    cpuMax: pick('cpu'),
    heapUsedMaxMB: Number((pick('heapUsed') / 1048576).toFixed(0)),
    heapMaxMB: Number(((samples[0]?.heapMax || 0) / 1048576).toFixed(0)),
    appCpuMax: pick('appCpu'),
    appRssMaxMB: Number((pick('appRssKb') / 1024).toFixed(0)),
  };
}

async function main() {
  if (MODE === 'load') await runLoad();
  else await runActions();
}

main().catch((e) => { console.error(e); process.exit(1); });
