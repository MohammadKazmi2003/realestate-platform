import { Queue, QueueEvents, type ConnectionOptions, type JobsOptions } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const connection: ConnectionOptions = { url: REDIS_URL };

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600 * 24 },
  removeOnFail: { age: 3600 * 24 * 7 },
};

// Single-doc search indexing: bursty writes for one listing collapse via
// jobId (the worker always re-reads the DB row, so latest state wins), while
// completed jobs are removed immediately so a later edit is never swallowed
// by jobId dedup. Failures keep exponential backoff + 7d retention for replay.
const searchIndexJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: { age: 3600 * 24 * 7 },
};

export const queues = {
  events: new Queue('events', { connection, defaultJobOptions }),
  analytics: new Queue('analytics', { connection, defaultJobOptions }),
  maintenance: new Queue('maintenance', { connection, defaultJobOptions }),
  searchIndex: new Queue('search-index', { connection, defaultJobOptions: searchIndexJobOptions }),
};

export const queueEvents = {
  events: new QueueEvents('events', { connection }),
  analytics: new QueueEvents('analytics', { connection }),
  maintenance: new QueueEvents('maintenance', { connection }),
  searchIndex: new QueueEvents('search-index', { connection }),
};

export async function isQueueAvailable(): Promise<boolean> {
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.ping();
    await client.quit();
    return true;
  } catch {
    return false;
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    queues.events.close(),
    queues.analytics.close(),
    queues.maintenance.close(),
    queues.searchIndex.close(),
    queueEvents.events.close(),
    queueEvents.analytics.close(),
    queueEvents.maintenance.close(),
    queueEvents.searchIndex.close(),
  ]);
}
