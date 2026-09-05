import { createClient } from '@supabase/supabase-js';
import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS } from './elasticsearch';
import { indexOne, deleteOne, type IndexEntity } from './indexDocs';
import { logger } from './logger';
// NOTE: ./queue (bullmq) is imported dynamically inside enqueueSearchIndex —
// static ESM deps of bullmq break jest's CJS transform, and producers only
// need it at call time.

// Incremental, event-driven search indexing.
//
// Normal flow: every listing mutation enqueues exactly one lightweight job
// {entity, id, op} (create/update → upsert, delete → delete). The worker
// rebuilds that single document from the DB row — never a full reindex.
// Full bulk sync stays in scripts/es-indexer.js + es-project-indexer.js as
// the admin/recovery path (mapping changes, restores, verified drift).

export type IndexOp = 'upsert' | 'delete';

export interface EnqueueInput {
  entity: IndexEntity;
  id: string;
  op?: IndexOp;
}

export type EnqueueResult = 'queued' | 'inline' | 'failed';

export function upsertJobId(entity: IndexEntity, id: string): string {
  return `si-${entity}-${id}-upsert`;
}

export function deleteJobId(entity: IndexEntity, id: string): string {
  return `si-${entity}-${id}-delete`;
}

/** Pure validation so API + callers share one contract. Returns a normalized op. */
export function validateEnqueueInput(input: {
  entity?: unknown;
  id?: unknown;
  op?: unknown;
}): { entity: IndexEntity; id: string; op: IndexOp } {
  const entity = input.entity;
  const id = input.id;
  const op = input.op ?? 'upsert';
  if (entity !== 'property' && entity !== 'project') {
    throw new Error(`Invalid entity (expected property|project)`);
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
    throw new Error('Invalid id');
  }
  if (op !== 'upsert' && op !== 'delete') {
    throw new Error(`Invalid op (expected upsert|delete)`);
  }
  return { entity, id, op };
}

/**
 * Enqueue one incremental index job. Safe to call after every mutation:
 * same-id upserts collapse via jobId (the worker re-reads the row, so the
 * latest state always wins), and a delete best-effort cancels a still-pending
 * upsert for the same id so a late upsert can never resurrect a deleted doc.
 * Never throws — callers must not fail a DB mutation because search lagged.
 */
export async function enqueueSearchIndex(raw: EnqueueInput): Promise<EnqueueResult> {
  let entity: IndexEntity;
  let id: string;
  let op: IndexOp;
  try {
    ({ entity, id, op } = validateEnqueueInput(raw));
  } catch (err) {
    logger.warn('[search-index] dropping invalid enqueue', err instanceof Error ? err.message : String(err));
    return 'failed';
  }

  let queueError: string | null = null;
  try {
    const { queues, isQueueAvailable } = await import('./queue');
    if (await isQueueAvailable()) {
      const queue = queues.searchIndex;
      if (op === 'delete') {
        try {
          const pending = await queue.getJob(upsertJobId(entity, id));
          if (pending) await pending.remove();
        } catch {
          // best-effort only; ordering edge is rare and self-heals via reconcile
        }
        await queue.add('delete', { entity, id }, { jobId: deleteJobId(entity, id) });
      } else {
        await queue.add('upsert', { entity, id }, { jobId: upsertJobId(entity, id) });
      }
      return 'queued';
    }
    queueError = 'redis ping failed';
  } catch (err) {
    queueError = err instanceof Error ? err.message : String(err);
  }
  logger.warn('[search-index] queue unavailable, falling back to inline', { reason: queueError });

  // Redis down: index inline (best-effort). The reconcile job repairs anything
  // missed if ES is down too.
  try {
    if (op === 'delete') await deleteOne(entity, id);
    else await indexOne(entity, id);
    return 'inline';
  } catch (err) {
    logger.warn('[search-index] inline index failed', err instanceof Error ? err.message : String(err));
    return 'failed';
  }
}

// --- Drift reconcile (admin/recovery, not the hot path) ---

export interface ReconcileReport {
  entity: IndexEntity;
  pgCount: number;
  esCount: number;
  missingInEs: string[];
  orphanInEs: string[];
  fixed: number;
}

export function diffIdSets(pgIds: Set<string> | string[], esIds: Set<string> | string[]): { missingInEs: string[]; orphanInEs: string[] } {
  const pg = pgIds instanceof Set ? pgIds : new Set(pgIds);
  const es = esIds instanceof Set ? esIds : new Set(esIds);
  return {
    missingInEs: Array.from(pg).filter((id) => !es.has(id)),
    orphanInEs: Array.from(es).filter((id) => !pg.has(id)),
  };
}

async function collectPgIds(table: string): Promise<Set<string>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('reconcile: missing Supabase env');
  const supabase = createClient(url, key);
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`reconcile: PG page failed: ${error.message}`);
    for (const row of data || []) ids.add((row as { id: string }).id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

async function collectEsIds(index: string): Promise<Set<string>> {
  const es = getElasticsearchClient();
  const ids = new Set<string>();
  let resp = await es.search({ index, scroll: '1m', size: 1000, _source: false, sort: ['_doc'] });
  for (;;) {
    const hits = (resp.hits?.hits || []) as Array<{ _id: string }>;
    for (const h of hits) ids.add(h._id);
    const scrollId = (resp as { _scroll_id?: string })._scroll_id;
    if (!scrollId || hits.length === 0) break;
    resp = await es.scroll({ scroll_id: scrollId, scroll: '1m' });
  }
  try {
    const lastScroll = (resp as { _scroll_id?: string })._scroll_id;
    if (lastScroll) await es.clearScroll({ scroll_id: lastScroll });
  } catch {
    // non-critical
  }
  return ids;
}

/**
 * Compare PG ids vs ES ids for one scope. With fix=true, enqueue an upsert
 * for every doc missing in ES and a delete for every orphan — small drifts
 * self-heal through the normal incremental path; large drift means run the
 * full-sync scripts instead.
 */
export async function reconcileScope(entity: IndexEntity, fix = false): Promise<ReconcileReport> {
  const table = entity === 'project' ? 'projects' : 'properties';
  const index = entity === 'project' ? PROJECTS_INDEX_ALIAS : ES_INDEX_ALIAS;
  const [pgIds, esIds] = await Promise.all([collectPgIds(table), collectEsIds(index)]);
  const { missingInEs, orphanInEs } = diffIdSets(pgIds, esIds);
  let fixed = 0;
  if (fix) {
    for (const id of missingInEs) {
      const r = await enqueueSearchIndex({ entity, id, op: 'upsert' });
      if (r !== 'failed') fixed++;
    }
    for (const id of orphanInEs) {
      const r = await enqueueSearchIndex({ entity, id, op: 'delete' });
      if (r !== 'failed') fixed++;
    }
  }
  return { entity, pgCount: pgIds.size, esCount: esIds.size, missingInEs, orphanInEs, fixed };
}
