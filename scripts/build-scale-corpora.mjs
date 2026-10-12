// Build deterministic scratch corpora for browse-path scale benchmarks.
//
// Usage: node scripts/build-scale-corpora.mjs <total> [--shards=N] [--tile=N] [--keep]
//   <total>        target total docs for bench_props + bench_projects (7/93 split)
//   --shards=N     number_of_shards for all three scratch indices (default 1)
//   --tile=N       target docs for bench_tile (default: same as total)
//   --keep         do not delete existing bench_* indices
//
// Creates bench_props / bench_projects from properties_v1 / projects_v1 and
// bench_tile from listings_tile, using the listings_tile mapping (lean,
// filter/sort fields only — no analyzers; matches the shipped tile projection).
// Docs are jittered copies with deterministic LCG so runs are reproducible.
// The benchmark server targets these via ES_PROPERTIES_INDEX / ES_PROJECTS_INDEX
// / ES_TILES_INDEX env overrides (defaults remain the live aliases).
import { Client } from '@elastic/elasticsearch';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
}
const sufx = (() => {
  const hit = process.argv.find((a) => a.startsWith('--suffix='));
  return hit ? hit.split('=')[1] : '';
})();
const TOTAL = Number(process.argv[2] || 100000);
const SHARDS = Math.max(1, arg('shards', 1));
const TILE_TOTAL = arg('tile', TOTAL);
const KEEP = process.argv.includes('--keep');
const BULK_DOCS = Math.max(500, arg('bulk', 2500));
const REFRESH_EVERY = Math.max(0, arg('refresh-every', 100));
// --dist: scatter docs across ~43 metro hotspots (Gaussian, sigma 0.12 deg)
// plus 10% uniform, so city viewports hold realistic match counts instead of
// the concentrated corpora's everything-in-two-cities pathology.
const DIST = process.argv.includes('--dist');
const ONLY = (() => {
  const hit = process.argv.find((a) => a.startsWith('--only='));
  return hit ? hit.split('=')[1].split(',') : ['props', 'projects', 'tile'];
})();
const PROPS = Math.round(TOTAL * 0.07);
const PROJECTS = TOTAL - PROPS;

const es = new Client({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200', requestTimeout: 300000 });

const FIELDS = ['id', 'entity_type', 'status', 'location', 'price', 'sort_price', 'low_price',
  'created_at', 'property_type', 'bhk_type', 'listing_purpose', 'bedrooms', 'bathrooms', 'area_sqft', 'amenities'];

let seed = 20261;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function readAll(index, fields) {
  const docs = [];
  let searchAfter = undefined;
  for (;;) {
    const res = await es.search({
      index, size: 1000, _source: fields, sort: [{ id: 'asc' }],
      ...(searchAfter ? { search_after: searchAfter } : {}),
    });
    const hits = res.hits.hits;
    if (!hits.length) break;
    for (const h of hits) docs.push(h._source);
    searchAfter = hits[hits.length - 1].sort;
    if (hits.length < 1000) break;
  }
  return docs;
}

const HOTSPOTS = [
  [19.076, 72.877], [28.614, 77.209], [12.972, 77.594], [17.385, 78.487], [18.520, 73.856],
  [13.083, 80.270], [22.573, 88.364], [23.023, 72.571], [26.912, 75.787], [21.170, 72.831],
  [26.847, 80.947], [26.450, 80.332], [21.146, 79.088], [22.720, 75.858], [19.218, 72.978],
  [23.260, 77.413], [17.687, 83.219], [25.594, 85.138], [22.307, 73.181], [30.901, 75.857],
  [27.177, 78.008], [19.997, 73.790], [25.318, 82.974], [31.634, 74.872], [25.435, 81.846],
  [23.344, 85.310], [11.017, 76.955], [23.181, 79.987], [26.219, 78.183], [16.506, 80.648],
  [26.239, 73.024], [9.925, 78.120], [21.251, 81.630], [25.213, 75.865], [26.144, 91.736],
  [30.733, 76.780], [12.296, 76.639], [28.367, 79.431], [28.535, 77.391], [25.205, 55.271],
  [25.346, 55.420], [24.453, 54.377], [25.405, 55.514],
];
function gaussian() {
  const u1 = Math.max(1e-9, rnd());
  const u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function jitter(copy, copyIdx, isTile) {
  const out = { ...copy, id: `${copy.id}__${copyIdx}` };
  if (out.location && typeof out.location === 'object' && typeof out.location.lat === 'number') {
    if (DIST) {
      if (rnd() < 0.1) {
        // 10% uniform across the market box
        out.location = { lat: 8 + rnd() * 27, lon: 54 + rnd() * 43 };
      } else {
        const [lat0, lon0] = HOTSPOTS[Math.floor(rnd() * HOTSPOTS.length)];
        out.location = { lat: lat0 + gaussian() * 0.12, lon: lon0 + gaussian() * 0.12 };
      }
    } else {
      const span = isTile ? 0.02 : 0.04;
      out.location = { lat: out.location.lat + (rnd() - 0.5) * span, lon: out.location.lon + (rnd() - 0.5) * span };
    }
  }
  const base = typeof out.price === 'number' ? out.price : out.low_price;
  if (typeof base === 'number') {
    const p = Math.round(base * (1 + 0.01 * copyIdx) * 100) / 100;
    out.price = p; out.sort_price = p; out.low_price = p;
  }
  if (out.created_at) {
    const t = Date.parse(out.created_at);
    if (Number.isFinite(t)) out.created_at = new Date(t + copyIdx * 3600_000).toISOString();
  }
  return out;
}

async function build(srcIndex, dstIndex, target, { fields, isTile = false } = {}) {
  const exists = await es.indices.exists({ index: dstIndex });
  if (exists) {
    if (KEEP) { console.log(`${dstIndex} exists — keep`); return; }
    console.log(`${dstIndex} exists — deleting`);
    await es.indices.delete({ index: dstIndex });
  }
  const srcMap = await es.indices.getMapping({ index: 'listings_tile' });
  await es.indices.create({
    index: dstIndex,
    settings: {
      number_of_shards: SHARDS,
      number_of_replicas: 0,
      refresh_interval: '-1',
      // Single merge thread: concurrent merges + bulk indexing wedged the
      // 2 GB-heap container on the first full-field tile build attempt.
      'index.merge.scheduler.max_thread_count': 1,
    },
    mappings: Object.values(srcMap)[0].mappings,
  });
  const docs = await readAll(srcIndex, fields);
  if (!docs.length) throw new Error(`no source docs in ${srcIndex}`);
  const copies = Math.ceil(target / docs.length);
  console.log(`${dstIndex}: ${docs.length} source docs x ${copies} copies = ~${docs.length * copies} (shards=${SHARDS})`);

  let pending = [];
  let indexed = 0;
  const flush = async () => {
    if (!pending.length) return;
    let attempt = 0;
    for (;;) {
      try {
        const res = await es.bulk({ operations: pending, refresh: false });
        if (res.errors) {
          const first = res.items.find((i) => i.index && i.index.error);
          throw new Error(`bulk error: ${JSON.stringify(first?.index?.error)?.slice(0, 300)}`);
        }
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 4) throw e;
        console.log(`  ${dstIndex}: bulk retry ${attempt} (${e?.message?.slice(0, 80)})`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    indexed += pending.length / 2;
    pending = [];
  };
  // 5000 docs per bulk (2500 index ops): smaller requests keep heap pressure
  // bounded on the 2 GB container.
  for (let c = 1; c <= copies; c++) {
    for (const d of docs) {
      const copy = jitter(d, c, isTile);
      pending.push({ index: { _index: dstIndex, _id: copy.id } });
      pending.push(copy);
      if (pending.length >= BULK_DOCS * 2) await flush();
    }
    if (REFRESH_EVERY > 0 && c % REFRESH_EVERY === 0) {
      // Periodic refresh bounds unrefreshed ops/translog growth on the small
      // shared container (the 1M tile build wedged ES twice without this).
      try { await es.indices.refresh({ index: dstIndex }); } catch { /* best-effort */ }
    }
    if (c % 50 === 0 || c === copies) {
      console.log(`  ${dstIndex}: copy ${c}/${copies} (${indexed} docs)`);
    }
  }
  await flush();
  await es.indices.refresh({ index: dstIndex });
  const count = await es.count({ index: dstIndex });
  const stats = await es.indices.stats({ index: dstIndex, metric: 'store' });
  console.log(`${dstIndex}: ${count.count} docs, ${(stats.indices[dstIndex].total.store.size_in_bytes / 1048576).toFixed(1)} MB`);
}

async function main() {
  console.log(`=== building corpora total=${TOTAL} (props=${PROPS}, projects=${PROJECTS}) tile=${TILE_TOTAL} shards=${SHARDS} suffix=${sufx} only=${ONLY.join(',')} ===`);
  if (ONLY.includes('props')) await build('properties_v1', `bench_props${sufx}`, PROPS, { fields: FIELDS });
  if (ONLY.includes('projects')) await build('projects_v1', `bench_projects${sufx}`, PROJECTS, { fields: FIELDS });
  // Lean tile corpus: same query-field subset as props/projects. Stored-only
  // preview fields are omitted to keep the 2 GB container stable at 5M docs;
  // this understates marker fetch bytes (noted in the report limitations).
  if (ONLY.includes('tile')) await build('listings_tile', `bench_tile${sufx}`, TILE_TOTAL, { fields: FIELDS, isTile: true });
  const heap = await es.nodes.stats({ metric: 'jvm', filter_path: 'nodes.*.jvm.mem.heap_used_in_bytes,nodes.*.jvm.mem.heap_max_in_bytes' });
  for (const n of Object.values(heap.nodes)) {
    console.log(`ES heap: ${(n.jvm.mem.heap_used_in_bytes / 1048576).toFixed(0)} / ${(n.jvm.mem.heap_max_in_bytes / 1048576).toFixed(0)} MB`);
  }
}

main().catch((e) => { console.error(e.meta?.body || e); process.exit(1); });
