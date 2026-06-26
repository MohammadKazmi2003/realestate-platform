import { Queue, QueueEvents, type ConnectionOptions, type JobsOptions } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const connection: ConnectionOptions = { url: REDIS_URL };

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600 * 24 },
  removeOnFail: { age: 3600 * 24 * 7 },
};

export const queues = {
  events: new Queue('events', { connection, defaultJobOptions }),
  analytics: new Queue('analytics', { connection, defaultJobOptions }),
  maintenance: new Queue('maintenance', { connection, defaultJobOptions }),
};

export const queueEvents = {
  events: new QueueEvents('events', { connection }),
  analytics: new QueueEvents('analytics', { connection }),
  maintenance: new QueueEvents('maintenance', { connection }),
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
    queueEvents.events.close(),
    queueEvents.analytics.close(),
    queueEvents.maintenance.close(),
  ]);
}
