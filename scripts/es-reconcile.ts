/**
 * ES drift reconcile (admin/recovery, NOT the hot path).
 *
 * Compares Postgres ids vs Elasticsearch ids per scope and reports drift:
 *   npx tsx scripts/es-reconcile.ts [properties|projects|all] [--fix]
 *
 * --fix enqueues an upsert for every doc missing in ES and a delete for
 * every orphan through the normal incremental path. If drift is large
 * (restored cluster, mapping change), run the full sync instead:
 *   node scripts/es-indexer.js full-sync
 *   node scripts/es-project-indexer.js full-sync
 */
import 'dotenv/config';
import { reconcileScope } from '../src/lib/searchIndex';
import type { IndexEntity } from '../src/lib/indexDocs';

async function main(): Promise<void> {
  const scope = process.argv[2] || 'all';
  const fix = process.argv.includes('--fix');
  const entities: IndexEntity[] =
    scope === 'all' ? ['property', 'project'] : scope === 'projects' ? ['project'] : ['property'];

  for (const entity of entities) {
    console.log(`\n--- ${entity} (fix=${fix}) ---`);
    const report = await reconcileScope(entity, fix);
    console.log(`PostgreSQL: ${report.pgCount} | Elasticsearch: ${report.esCount}`);
    console.log(`Missing in ES: ${report.missingInEs.length} | Orphans in ES: ${report.orphanInEs.length}`);
    if (report.missingInEs.length > 0) console.log('  missing:', report.missingInEs.slice(0, 20).join(', '));
    if (report.orphanInEs.length > 0) console.log('  orphans:', report.orphanInEs.slice(0, 20).join(', '));
    if (fix) console.log(`Repair jobs enqueued: ${report.fixed}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Reconcile failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
