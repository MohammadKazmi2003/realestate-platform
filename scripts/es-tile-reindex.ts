// Backfill the lightweight listings_tile index from the legacy indices.
//
// Read-mostly: pages through properties_search + projects_search, projects each
// doc down to the tile allowlist, bulk-indexes into listings_tile by id.
// Idempotent — safe to re-run after a partial run or after reconcile.
//
// Run: npx tsx scripts/es-tile-reindex.ts
import * as fs from 'fs';
import * as path from 'path';
import {
  getElasticsearchClient,
  ES_INDEX_ALIAS,
  PROJECTS_INDEX_ALIAS,
  TILES_INDEX_ALIAS,
} from '../src/lib/elasticsearch';
import { TILE_DOC_FIELDS } from '../src/lib/indexDocs';

async function applyTemplate(es: any): Promise<void> {
  const p = path.join(__dirname, '..', 'es-config', 'listings-tile-template.json');
  const tpl = JSON.parse(fs.readFileSync(p, 'utf8'));
  await es.indices.putIndexTemplate({ name: 'listings_tile_template', body: tpl });
  console.log('putIndexTemplate listings_tile_template');
}

async function ensureIndex(es: any): Promise<void> {
  const exists = await es.indices.exists({ index: TILES_INDEX_ALIAS }).catch(() => false);
  if (exists) return;
  // Read settings/mappings straight off the template so index and template can
  // never drift (they would otherwise be two copies of the same contract).
  const p = path.join(__dirname, '..', 'es-config', 'listings-tile-template.json');
  const tpl = JSON.parse(fs.readFileSync(p, 'utf8'));
  await es.indices.create({ index: TILES_INDEX_ALIAS, body: tpl.template });
  console.log(`created index ${TILES_INDEX_ALIAS}`);
}

async function backfillFrom(es: any, src: string): Promise<number> {
  let searchAfter: any = undefined;
  let total = 0;
  for (;;) {
    const res: any = await es.search({
      index: src,
      size: 1000,
      sort: [{ id: 'asc' }],
      ...(searchAfter ? { search_after: searchAfter } : {}),
      _source: TILE_DOC_FIELDS,
    });
    const hits = res.hits.hits || [];
    if (!hits.length) break;
    const ops: any[] = [];
    for (const h of hits) {
      const s = h._source || {};
      if (s.status === 'deleted') continue;
      const doc: Record<string, unknown> = {};
      for (const k of TILE_DOC_FIELDS) doc[k] = s[k] ?? null;
      if (doc.entity_type === 'project') {
        const low = (doc.low_price as number) ?? 0;
        doc.price = low;
        doc.sort_price = low;
      }
      ops.push({ index: { _index: TILES_INDEX_ALIAS, _id: h._id } }, doc);
    }
    if (ops.length) await es.bulk({ operations: ops, refresh: false });
    total += hits.length;
    console.log(`tile-reindex ${src}: +${hits.length} (total ${total})`);
    searchAfter = hits[hits.length - 1].sort;
    if (hits.length < 1000) break;
  }
  return total;
}

async function main() {
  const es: any = getElasticsearchClient();
  await applyTemplate(es);
  await ensureIndex(es);
  let total = 0;
  total += await backfillFrom(es, ES_INDEX_ALIAS);
  total += await backfillFrom(es, PROJECTS_INDEX_ALIAS);
  await es.indices.refresh({ index: TILES_INDEX_ALIAS });
  const count = await es.count({ index: TILES_INDEX_ALIAS });
  console.log(`tile-reindex done: processed=${total} indexed=${count.count}`);
}

main().catch((e) => {
  console.error('tile-reindex failed:', e.message);
  process.exit(1);
});
