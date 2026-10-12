// Create an index-sorted variant of a bench index (reindex server-side) to
// measure the effect of index sorting on top-k collection (list, tile
// top_hits, fill) for the sort field/order.
//
// Usage:
//   node scripts/make-sorted-variant.mjs <src> <dst> <field> <asc|desc> [--forcemerge]
import { Client } from '@elastic/elasticsearch';

const [src, dst, field, order] = process.argv.slice(2);
const FORCE = process.argv.includes('--forcemerge');
if (!src || !dst || !field || !order) {
  console.error('usage: node scripts/make-sorted-variant.mjs <src> <dst> <field> <asc|desc> [--forcemerge]');
  process.exit(1);
}
const es = new Client({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200', requestTimeout: 600000 });

const exists = await es.indices.exists({ index: dst });
if (exists) { console.log(`${dst} exists — deleting`); await es.indices.delete({ index: dst }); }

const srcMap = await es.indices.getMapping({ index: src });
await es.indices.create({
  index: dst,
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    refresh_interval: '-1',
    'index.merge.scheduler.max_thread_count': 1,
    'index.sort.field': field,
    'index.sort.order': order,
  },
  mappings: Object.values(srcMap)[0].mappings,
});

console.log(`reindexing ${src} -> ${dst} sorted by ${field} ${order}...`);
const res = await es.reindex({ wait_for_completion: false, source: { index: src, size: 2000 }, dest: { index: dst } });
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = await es.tasks.get({ task_id: res.task });
  if (t.completed) { console.log(`done: created=${t.response?.created} failures=${(t.response?.failures || []).length}`); break; }
  process.stdout.write('.');
}

if (FORCE) {
  console.log('forcemerge to 1 segment (best-case index-sort effect)...');
  await es.indices.forcemerge({ index: dst, max_num_segments: 1 });
}
await es.indices.refresh({ index: dst });
const count = await es.count({ index: dst });
console.log(`${dst}: ${count.count} docs`);
await es.close();
