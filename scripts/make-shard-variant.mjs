// Create an N-shard variant of an existing bench index via server-side reindex.
// Used to measure per-shard fan-out / shard-level workload without rebuilding
// the corpus from the client.
//
// Usage: node scripts/make-shard-variant.mjs bench_tile_100k bench_tile_100k_s6 6
import { Client } from '@elastic/elasticsearch';

const [src, dst, shardsArg] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node scripts/make-shard-variant.mjs <src> <dst> <shards>');
  process.exit(1);
}
const SHARDS = Math.max(1, Number(shardsArg || 6));
const es = new Client({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200', requestTimeout: 300000 });

const exists = await es.indices.exists({ index: dst });
if (exists) {
  console.log(`${dst} exists — deleting`);
  await es.indices.delete({ index: dst });
}
const srcMap = await es.indices.getMapping({ index: src });
await es.indices.create({
  index: dst,
  settings: {
    number_of_shards: SHARDS,
    number_of_replicas: 0,
    refresh_interval: '-1',
    'index.merge.scheduler.max_thread_count': 1,
  },
  mappings: Object.values(srcMap)[0].mappings,
});
console.log(`reindexing ${src} -> ${dst} (${SHARDS} shards)...`);
const res = await es.reindex({
  wait_for_completion: false,
  source: { index: src, size: 1000 },
  dest: { index: dst },
});
const taskId = res.task;
console.log(`task=${taskId}`);
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const t = await es.tasks.get({ task_id: taskId });
  if (t.completed) {
    const status = t.response;
    console.log(`done: created=${status?.created} failures=${(status?.failures || []).length}`);
    break;
  }
  process.stdout.write('.');
}
await es.indices.refresh({ index: dst });
const count = await es.count({ index: dst });
console.log(`${dst}: ${count.count} docs`);
await es.close();
