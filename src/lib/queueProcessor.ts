import { Queue, type Job, type ConnectionOptions } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    `queueProcessor: Missing Supabase credentials. ` +
    `Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) in your .env file.`
  );
}

const connection: ConnectionOptions = { url: REDIS_URL };

export type ProcessResult = {
  events_processed: number;
  analytics_processed: number;
  maintenance_processed: number;
  errors: string[];
};



async function processEventJob(job: Job, supabase: ReturnType<typeof createClient>): Promise<void> {
  const { data } = job;

  const { error } = await supabase.from('action_logs').insert({
    user_id: data.user_id || null,
    action: data.action,
    entity_type: data.entity_type,
    entity_id: data.entity_id,
    metadata: data.metadata || null,
  });
  if (error) throw new Error(`Action insert failed: ${error.message}`);
}

async function processAnalyticsJob(job: Job, supabase: ReturnType<typeof createClient>): Promise<void> {
  const jobData = job.data as Record<string, unknown>;
  const { error } = await supabase.from('search_analytics').insert({
    session_id: (jobData.session_id as string) || null,
    query_text: jobData.query_text as string,
    total_results: jobData.total_results as number,
    latency_ms: jobData.latency_ms as number,
    filters: (jobData.filters as Record<string, unknown>) || {},
    result_count: jobData.total_results as number,
  });
  if (error) throw new Error(`Analytics insert failed: ${error.message}`);
}

async function processMaintenanceJob(job: Job, supabase: ReturnType<typeof createClient>): Promise<void> {
  if (job.name === 'purge_event_logs') {
    const retentionDays = job.data.retentionDays || 90;
    const { error } = await supabase.rpc('purge_old_event_logs', {
      retention_days: retentionDays,
    });
    if (error) throw new Error(`Purge failed: ${error.message}`);
  }
}

export async function processAllQueues(maxJobsPerQueue = 50): Promise<ProcessResult> {
  const result: ProcessResult = {
    events_processed: 0,
    analytics_processed: 0,
    maintenance_processed: 0,
    errors: [],
  };

  let supabase: ReturnType<typeof createClient> | null = null;

  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const eventQueue = new Queue('events', { connection });
    const analyticsQueue = new Queue('analytics', { connection });
    const maintenanceQueue = new Queue('maintenance', { connection });

    // Process events queue
    try {
      const eventJobs = await eventQueue.getJobs(['waiting'], 0, maxJobsPerQueue);
      for (const job of eventJobs) {
        try {
          await processEventJob(job, supabase);
          await job.remove();
          result.events_processed++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Event job ${job.id}: ${msg}`);
          await job.moveToFailed(err instanceof Error ? err : new Error(msg), 'queue-processor', true);
        }
      }
    } catch (err: unknown) {
      result.errors.push(`Events queue: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Process analytics queue
    try {
      const analyticsJobs = await analyticsQueue.getJobs(['waiting'], 0, maxJobsPerQueue);
      for (const job of analyticsJobs) {
        try {
          await processAnalyticsJob(job, supabase);
          await job.remove();
          result.analytics_processed++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Analytics job ${job.id}: ${msg}`);
          await job.moveToFailed(err instanceof Error ? err : new Error(msg), 'queue-processor', true);
        }
      }
    } catch (err: unknown) {
      result.errors.push(`Analytics queue: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Process maintenance queue
    try {
      const maintenanceJobs = await maintenanceQueue.getJobs(['waiting'], 0, maxJobsPerQueue);
      for (const job of maintenanceJobs) {
        try {
          await processMaintenanceJob(job, supabase);
          await job.remove();
          result.maintenance_processed++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Maintenance job ${job.id}: ${msg}`);
          await job.moveToFailed(err instanceof Error ? err : new Error(msg), 'queue-processor', true);
        }
      }
    } catch (err: unknown) {
      result.errors.push(`Maintenance queue: ${err instanceof Error ? err.message : String(err)}`);
    }

    await Promise.all([
      eventQueue.close(),
      analyticsQueue.close(),
      maintenanceQueue.close(),
    ]);

  } catch (err: unknown) {
    result.errors.push(`General: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
