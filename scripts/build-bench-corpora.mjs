// Build lean two-index benchmark corpora at a target scale (properties + projects).
// Usage: node scripts/build-bench-corpora.mjs 1000000
// Creates bench_props/bench_projects (~7% / 93% split) from properties_v1/projects_v1.
// Point the read aliases at them for e2e runs, then swap back and delete:
//   node scripts/bench-count-strategies.js bench_props,bench_projects
import { createRequire } from 'module';
const require = createRequire('/Users/mohammadkazmi/realestate-projects/realestate-platform/package.json');
const { Client } = require('@elastic/elasticsearch');

const TOTAL = Number(process.argv[2] || 100000);
const PROPS = Math.round(TOTAL * 0.07);
const PROJECTS = TOTAL - PROPS;
const SRC_PROPS = 'properties_v1';
const SRC_PROJECTS = 'projects_v1';
const DST_PROPS = 'bench_props';
const DST_PROJECTS = 'bench_projects';
const es = new Client({ node: 'http://localhost:9200', requestTimeout: 120000 });

const FIELDS = ['id', 'entity_type', 'status', 'location', 'price', 'sort_price', 'low_price',
  'created_at', 'property_type', 'bhk_type', 'listing_purpose', 'bedrooms', 'bathrooms', 'area_sqft', 'amenities'];

let seed = 20261;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function readAll(index) {
  const docs = [];
  let searchAfter = undefined;
  for (;;) {
    const res = await es.search({
      index, size: 1000, _source: FIELDS, sort: [{ id: 'asc' }],
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

async function build(srcIndex, dstIndex, target) {
  const exists = await es.indices.exists({ index: dstIndex }).catch(() => false);
  if (exists) {
    console.log(`${dstIndex} exists — deleting`);
    await es.indices.delete({ index: dstIndex });
  }
  const srcMap = await es.indices.getMapping({ index: 'listings_tile' });
  await es.indices.create({
    index: dstIndex,
    settings: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '-1' },
    mappings: Object.values(srcMap)[0].mappings,
  });
  const docs = await readAll(srcIndex);
  if (!docs.length) throw new Error(`no source docs in ${srcIndex}`);
  const copies = Math.ceil(target / docs.length);
  console.log(`${dstIndex}: ${docs.length} source docs x ${copies} copies = ~${docs.length * copies}`);

  let pending = [];
  let indexed = 0;
  const flush = async () => {
    if (!pending.length) return;
    await es.bulk({ operations: pending, refresh: false });
    indexed += pending.length / 2;
    pending = [];
  };
  for (let c = 1; c <= copies; c++) {
    for (const d of docs) {
      const copy = { ...d, id: `${d.id}__${c}` };
      if (copy.location && typeof copy.location === 'object' && typeof copy.location.lat === 'number') {
        copy.location = { lat: copy.location.lat + (rnd() - 0.5) * 0.04, lon: copy.location.lon + (rnd() - 0.5) * 0.04 };
      }
      const base = typeof copy.price === 'number' ? copy.price : copy.low_price;
      if (typeof base === 'number') {
        const p = Math.round(base * (1 + 0.01 * c) * 100) / 100;
        copy.price = p; copy.sort_price = p; copy.low_price = p;
      }
      if (copy.created_at) {
        const t = Date.parse(copy.created_at);
        if (Number.isFinite(t)) copy.created_at = new Date(t + c * 3600_000).toISOString();
      }
      pending.push({ index: { _index: dstIndex, _id: copy.id } });
      pending.push(copy);
      if (pending.length >= 10000) await flush();
    }
    if (c % 200 === 0) console.log(`  ${dstIndex}: copy ${c}/${copies} (${indexed} docs)`);
  }
  await flush();
  await es.indices.refresh({ index: dstIndex });
  const count = await es.count({ index: dstIndex });
  const stats = await es.indices.stats({ index: dstIndex, metric: 'store' });
  console.log(`${dstIndex}: ${count.count} docs, ${(stats.indices[dstIndex].total.store.size_in_bytes / 1048576).toFixed(1)} MB`);
}

async function main() {
  console.log(`=== building corpora total=${TOTAL} (props=${PROPS}, projects=${PROJECTS}) ===`);
  await build(SRC_PROPS, DST_PROPS, PROPS);
  await build(SRC_PROJECTS, DST_PROJECTS, PROJECTS);
  const heap = await es.nodes.stats({ metric: 'jvm', filter_path: 'nodes.*.jvm.mem.heap_used_in_bytes,nodes.*.jvm.mem.heap_max_in_bytes' });
  for (const n of Object.values(heap.nodes)) {
    console.log(`ES heap: ${(n.jvm.mem.heap_used_in_bytes / 1048576).toFixed(0)} / ${(n.jvm.mem.heap_max_in_bytes / 1048576).toFixed(0)} MB`);
  }
}
main().catch((e) => { console.error(e.meta?.body || e); process.exit(1); });
