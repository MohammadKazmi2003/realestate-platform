import 'dotenv/config';

import { Worker, type ConnectionOptions } from 'bullmq';
import { createClient } from '@supabase/supabase-js';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const connection: ConnectionOptions = { url: REDIS_URL };

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

type AnalyticsRecord = {
  session_id: string | null;
  query_text: string;
  total_results: number;
  latency_ms: number;
  filters: Record<string, unknown>;
  result_count: number;
};

// ---- Analytics Buffer ----
const ANALYTICS_BUFFER: AnalyticsRecord[] = [];
const ANALYTICS_FLUSH_INTERVAL = 2000;

async function flushAnalyticsBuffer(): Promise<void> {
  if (ANALYTICS_BUFFER.length === 0) return;
  const batch = ANALYTICS_BUFFER.splice(0, ANALYTICS_BUFFER.length);
  try {
    const { error } = await supabase.from('search_analytics').insert(batch);
    if (error) console.error('[Worker] Analytics batch insert failed:', error.message);
    else console.log(`[Worker] Flushed ${batch.length} analytics entries`);
  } catch (err: unknown) {
    console.error('[Worker] Analytics batch insert error:', err instanceof Error ? err.message : String(err));
  }
}

let analyticsFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAnalyticsFlush(): void {
  if (analyticsFlushTimer) return;
  analyticsFlushTimer = setTimeout(() => {
    analyticsFlushTimer = null;
    flushAnalyticsBuffer().then(() => {
      if (ANALYTICS_BUFFER.length > 0) scheduleAnalyticsFlush();
    });
  }, ANALYTICS_FLUSH_INTERVAL);
}

// ---- Workers ----

type EventJobData = {
  action?: string;
  entity_type?: string;
  entity_id?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
};

type AnalyticsJobData = {
  session_id?: string;
  query_text: string;
  total_results: number;
  latency_ms: number;
  filters?: Record<string, unknown>;
};

const eventWorker = new Worker<EventJobData>(
  'events',
  async (job) => {
    const { data } = job;

    const { error } = await supabase.from('action_logs').insert({
      user_id: data.user_id || null,
      action: data.action || '',
      entity_type: data.entity_type || '',
      entity_id: data.entity_id || null,
      metadata: data.metadata || null,
    });
    if (error) {
      console.error('[Worker] Action insert failed:', error.message);
      throw error;
    }
  },
  { connection }
);

const analyticsWorker = new Worker<AnalyticsJobData>(
  'analytics',
  async (job) => {
    const { data } = job;

    ANALYTICS_BUFFER.push({
      session_id: data.session_id || null,
      query_text: data.query_text,
      total_results: data.total_results,
      latency_ms: data.latency_ms,
      filters: data.filters || {},
      result_count: data.total_results,
    });
    scheduleAnalyticsFlush();
  },
  { connection }
);

type MaintenanceJobData = {
  retentionDays?: number;
};

// ---- Incremental search indexing ----
// One job = one listing. The document is rebuilt from the live DB row at
// execution time, so collapsed bursts always converge to latest state and
// processing is naturally idempotent — safe to retry indefinitely.

type SearchIndexJobData = {
  entity?: string;
  id?: string;
};

const searchIndexWorker = new Worker<SearchIndexJobData>(
  'search-index',
  async (job) => {
    const { indexOne, deleteOne } = await import('../lib/indexDocs');
    const entity = job.data.entity;
    const id = job.data.id;
    if ((entity !== 'property' && entity !== 'project') || typeof id !== 'string' || !id) {
      throw new Error(`[Worker] search-index: invalid payload ${JSON.stringify(job.data)?.slice(0, 120)}`);
    }
    if (job.name === 'delete') {
      await deleteOne(entity, id);
      console.log(`[Worker] search-index: deleted ${entity} ${id}`);
    } else {
      const outcome = await indexOne(entity, id);
      console.log(`[Worker] search-index: ${outcome} ${entity} ${id}`);
    }
  },
  { connection, concurrency: 5 }
);

// Terminal failures (all BullMQ attempts exhausted): dead-letter to event_logs
// so nothing is lost silently — replay via reconcile or the failed set.
searchIndexWorker.on('failed', (job, err) => {
  const attempts = job?.opts?.attempts ?? 1;
  if (!job || job.attemptsMade < attempts) return; // will retry with backoff
  console.error(`[Worker] search-index: permanently failed ${job.data?.entity} ${job.data?.id}:`, err.message);
  supabase
    .from('event_logs')
    .insert({
      property_id: job.data?.entity === 'property' ? job.data?.id : null,
      event_type: 'reindex_failure',
      user_id: null,
    })
    .then(({ error }) => {
      if (error) console.error('[Worker] dead-letter insert failed:', error.message);
    });
});

const maintenanceWorker = new Worker<MaintenanceJobData>(
  'maintenance',
  async (job) => {
    if (job.name === 'purge_event_logs') {
      const retentionDays = job.data.retentionDays || 90;
      console.log(`[Worker] Purging event logs older than ${retentionDays} days...`);
      try {
        const { data, error } = await supabase.rpc('purge_old_event_logs', {
          retention_days: retentionDays,
        });
        if (error) {
          console.error('[Worker] Purge failed:', error.message);
          return;
        }
        console.log(`[Worker] Purge complete: ${data} rows deleted`);
      } catch (err: unknown) {
        console.error('[Worker] Purge error:', err instanceof Error ? err.message : String(err));
      }
    }
  },
  { connection }
);

// ---- Graceful shutdown ----
async function shutdown(): Promise<void> {
  console.log('[Worker] Shutting down...');
  await flushAnalyticsBuffer();
  await eventWorker.close();
  await analyticsWorker.close();
  await maintenanceWorker.close();
  await searchIndexWorker.close();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---- Schedule repeatable maintenance jobs ----
// Uses Redis SET NX to ensure only one worker instance in a cluster
// registers the repeatable job (prevents duplicate scheduling).
async function scheduleMaintenance(): Promise<void> {
  const lockKey = 'worker:schedule-maintenance';
  const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
  if (acquired !== 'OK') {
    console.log('[Worker] Maintenance scheduling lock held by another worker — skipping');
    return;
  }

  try {
    const { Queue } = await import('bullmq');
    const maintenanceQueue = new Queue('maintenance', { connection });

    const existing = await maintenanceQueue.getRepeatableJobs();
    await Promise.all(existing.map(j => maintenanceQueue.removeRepeatableByKey(j.key)));

    await maintenanceQueue.add(
      'purge_event_logs',
      { retentionDays: 90 },
      {
        repeat: { pattern: '0 3 * * *' },
        jobId: 'purge-event-logs-daily',
      }
    );

    console.log('[Worker] Scheduled: purge_event_logs daily at 3:00 AM');
    await maintenanceQueue.close();
  } finally {
    await redis.del(lockKey);
  }
}

scheduleMaintenance().catch((err: unknown) => {
  console.error('[Worker] Failed to schedule maintenance:', err instanceof Error ? err.message : String(err));
});

// ---- Counter snapshot to Postgres every 5 minutes ----
// Uses batched SCAN + MGET + batch upsert. Never loads all keys into memory,
// so it scales to millions of counter keys without blocking Redis or Postgres.
const SNAPSHOT_BATCH = 1000;

async function snapshotCounters(): Promise<void> {
  let totalCount = 0;
  try {
    for (const pattern of ['prop:views:*', 'prop:clicks:*']) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SNAPSHOT_BATCH);
        cursor = nextCursor;

        if (keys.length === 0) continue;

        const values = await redis.mget(...keys);
        const batch = keys.map((key, i) => ({
          counter_key: key,
          counter_value: parseInt(values[i] || '0', 10),
          updated_at: new Date().toISOString(),
        }));

        const { error } = await supabase
          .from('event_counters')
          .upsert(batch, { onConflict: 'counter_key' });

        if (error) {
          console.error(`[Worker] Snapshot batch failed:`, error.message);
        } else {
          totalCount += batch.length;
        }
      } while (cursor !== '0');
    }
    console.log(`[Worker] Snapshotted ${totalCount} counters to Postgres`);
  } catch (err: unknown) {
    console.error('[Worker] Counter snapshot error:', err instanceof Error ? err.message : String(err));
  }
}

// Snapshot every 5 minutes
setInterval(snapshotCounters, 5 * 60 * 1000);
snapshotCounters(); // Also run immediately on startup

console.log('[Worker] Started. Listening for jobs...');
console.log(`  Events queue:     audit actions (log_action)`);
console.log(`  Analytics queue:  ${ANALYTICS_FLUSH_INTERVAL}ms flush`);
console.log(`  Maintenance:      purge_event_logs daily at 3AM`);
console.log(`  Search-index:     single-doc upsert/delete x5 concurrency`);
console.log(`  Counter snapshot: every 5 minutes to event_counters table`);
