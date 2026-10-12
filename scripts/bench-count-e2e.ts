// End-to-end split-counts vs inline-counts A/B.
//
// Drives two servers that differ ONLY in the counting strategy
// (SPLIT_COUNTS=1 vs SPLIT_COUNTS=0, NATIVE_COUNTS=1) against the same corpus
// and records, per scenario: wall latency, ES shard-query delta, cache state,
// and Server-Timing phases.
//
// Scenarios are ordered so the split strategy's count reuse (population-only
// cache key) shows up: page1 cold → warm → re-sort (new list key, same
// population) → second re-sort → Load More page 2 / 3 (same population).
//
// Usage:
//   npx tsx scripts/bench-count-e2e.ts --split=http://localhost:3210 \
//     --inline=http://localhost:3220 --label=100k --flush=true
import 'dotenv/config';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { coveringTileUnionBounds } from '@/lib/mapTiles';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const SPLIT = String(args.split || 'http://localhost:3210');
const INLINE = String(args.inline || 'http://localhost:3220');
const LABEL = String(args.label || 'x');
const DO_FLUSH = args.flush !== 'false';
const ES = String(args.es || process.env.ELASTICSEARCH_URL || 'http://localhost:9200');

const DELHI = { minLat: 28.30, maxLat: 28.80, minLng: 76.90, maxLng: 77.50 };
const ZOOM = 11;

function mapDataUrl(base: string, sort: string): string {
  const c = coveringTileUnionBounds(DELHI, ZOOM);
  const qp = new URLSearchParams({
    minLat: c.minLat.toFixed(6), maxLat: c.maxLat.toFixed(6),
    minLng: c.minLng.toFixed(6), maxLng: c.maxLng.toFixed(6),
    zoom: String(ZOOM), scope: 'both', pageSize: '24', sort, listingPurpose: 'Sell',
  });
  return `${base}/api/map-data?${qp.toString()}`;
}

let ipc = 0;
const ip = () => `10.11.${Math.floor(ipc / 250)}.${(ipc++ % 250) + 1}`;

async function esQueryTotal(): Promise<number> {
  const r = await fetch(`${ES}/_nodes/stats/indices/search?filter_path=nodes.*.indices.search.query_total`);
  const j: any = await r.json();
  let t = 0;
  for (const n of Object.values<any>(j.nodes || {})) t += n.indices?.search?.query_total || 0;
  return t;
}

type Row = { scenario: string; wallMs: number; esQueries: number; cache: string; phases: Record<string, number>; status: number; total?: number; nextCursor?: any };

async function req(url: string, init: RequestInit = {}): Promise<Row & { body: any }> {
  const q0 = await esQueryTotal();
  const t0 = performance.now();
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), ...(init.headers || {}) } });
  const text = await res.text();
  const wallMs = performance.now() - t0;
  const esQueries = (await esQueryTotal()) - q0;
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* noop */ }
  const phases: Record<string, number> = {};
  for (const part of (res.headers.get('server-timing') || '').split(',')) {
    const m = part.trim().match(/^([\w-]+);dur=([\d.]+)/);
    if (m) phases[m[1]] = Number(m[2]);
  }
  return { scenario: '', wallMs, esQueries, cache: res.headers.get('x-cache') || '', phases, status: res.status, total: body.total, nextCursor: body.nextCursor, body };
}

function flush() {
  try { execSync('node scripts/flush-app-cache.mjs', { stdio: 'pipe' }); } catch { /* noop */ }
}

async function runServer(base: string, name: string): Promise<Row[]> {
  if (DO_FLUSH) { flush(); }
  const rows: Row[] = [];
  const push = (r: Row, scenario: string) => { r.scenario = scenario; rows.push(r); return r; };

  const p1 = push(await req(mapDataUrl(base, 'newest')), 'page1_cold');
  const p1w = push(await req(mapDataUrl(base, 'newest')), 'page1_warm');
  // Re-sorts: SAME population (filters/bounds), new list key. Split should
  // reuse the population-keyed count; inline recounts inside the list query.
  push(await req(mapDataUrl(base, 'price_desc')), 'resort_price_desc_cold');
  push(await req(mapDataUrl(base, 'beds')), 'resort_beds_cold');
  push(await req(mapDataUrl(base, 'price_desc')), 'resort_price_desc_warm');

  // Load More pages: /api/search with cursor from page 1.
  let cursor = p1.body?.nextCursor ?? null;
  for (const page of [2, 3]) {
    if (!cursor) break;
    const r = push(
      await req(`${base}/api/search`, {
        method: 'POST',
        body: JSON.stringify({ scope: 'both', sort: 'newest', pageSize: 24, listingPurpose: 'Sell', cursor }),
      }),
      `search_page${page}`
    );
    cursor = r.body?.nextCursor ?? null;
  }
  void p1w;

  console.log(`\n### ${name} (${base})`);
  console.log('scenario                       wall   esQ  cache                     | rl  cache  ping quant list mark fill ser');
  for (const r of rows) {
    const ph = r.phases;
    console.log(
      `${r.scenario.padEnd(30)} ${r.wallMs.toFixed(0).padStart(5)} ${String(r.esQueries).padStart(4)}  ${(r.cache || '-').padEnd(24)} | ` +
      ['rl', 'cache', 'ping', 'quantile', 'list', 'markers', 'fill', 'serialize'].map((k) => (ph[k] ?? 0).toFixed(1).padStart(5)).join(' ')
    );
  }
  return rows;
}

async function main() {
  console.log(`# count e2e label=${LABEL} split=${SPLIT} inline=${INLINE}`);
  const splitRows = await runServer(SPLIT, 'split (SPLIT_COUNTS=1)');
  const inlineRows = await runServer(INLINE, 'inline (SPLIT_COUNTS=0)');

  console.log('\n### comparison (split vs inline)');
  console.log('scenario                       split wall/es   inline wall/es   wall Δ%   es Δ');
  for (let i = 0; i < Math.min(splitRows.length, inlineRows.length); i++) {
    const a = splitRows[i], b = inlineRows[i];
    const d = ((a.wallMs - b.wallMs) / b.wallMs) * 100;
    console.log(
      `${a.scenario.padEnd(30)} ${a.wallMs.toFixed(0).padStart(6)} / ${String(a.esQueries).padStart(2)}    ${b.wallMs.toFixed(0).padStart(6)} / ${String(b.esQueries).padStart(2)}    ${(d >= 0 ? '+' : '') + d.toFixed(0)}%    ${a.esQueries - b.esQueries >= 0 ? '+' : ''}${a.esQueries - b.esQueries}`
    );
  }

  mkdirSync('bench-results', { recursive: true });
  const file = `bench-results/count-e2e-${LABEL}.json`;
  writeFileSync(file, JSON.stringify({ label: LABEL, split: splitRows, inline: inlineRows }, null, 2));
  console.log(`\n# wrote ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
