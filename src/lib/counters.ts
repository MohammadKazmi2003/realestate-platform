import { getRedisClient } from './redis';
import type Redis from 'ioredis';

const KEY_VIEWS_PROP = 'prop:views:';
const KEY_CLICKS_PROP = 'prop:clicks:';
const KEY_VIEWS_OWNER = 'owner:views:';
const KEY_CLICKS_OWNER = 'owner:clicks:';

const FLUSH_INTERVAL_MS = 100;
const FLUSH_MAX_CMDS = 500;

// Pipeline buffer — accumulates INCR commands across HTTP requests
// into a single large pipeline flush. At 100K events/sec this sends
// ~200 pipeline batches/sec (500 cmds each) instead of 400K individual ops.
let pipeline: ReturnType<Redis['pipeline']> | null = null;
let pipelineCmdCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function getPipeline(): ReturnType<Redis['pipeline']> {
  if (!pipeline) {
    pipeline = getRedisClient().pipeline();
  }
  return pipeline;
}

async function flushPipeline(): Promise<void> {
  const p = pipeline;
  const count = pipelineCmdCount;
  pipeline = null;
  pipelineCmdCount = 0;

  if (!p || count === 0) return;

  try {
    await p.exec();
  } catch {
    // pipeline failures are non-critical — counters are eventually consistent
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushPipeline();
  }, FLUSH_INTERVAL_MS);
}

async function flushBeforeRead(): Promise<void> {
  if (pipeline && pipelineCmdCount > 0) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushPipeline();
  }
}

export async function incrView(propertyId: string, ownerId: string): Promise<void> {
  try {
    const p = getPipeline();
    p.incr(`${KEY_VIEWS_PROP}${propertyId}`);
    p.incr(`${KEY_VIEWS_OWNER}${ownerId}`);
    p.expire(`${KEY_VIEWS_PROP}${propertyId}`, 86400 * 90);
    p.expire(`${KEY_VIEWS_OWNER}${ownerId}`, 86400 * 90);
    pipelineCmdCount += 4;

    if (pipelineCmdCount >= FLUSH_MAX_CMDS) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flushPipeline();
    } else {
      scheduleFlush();
    }
  } catch {
    // incr failures are non-critical
  }
}

export async function incrClick(propertyId: string, ownerId: string): Promise<void> {
  try {
    const p = getPipeline();
    p.incr(`${KEY_CLICKS_PROP}${propertyId}`);
    p.incr(`${KEY_CLICKS_OWNER}${ownerId}`);
    p.expire(`${KEY_CLICKS_PROP}${propertyId}`, 86400 * 90);
    p.expire(`${KEY_CLICKS_OWNER}${ownerId}`, 86400 * 90);
    pipelineCmdCount += 4;

    if (pipelineCmdCount >= FLUSH_MAX_CMDS) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await flushPipeline();
    } else {
      scheduleFlush();
    }
  } catch {
    // incr failures are non-critical
  }
}

export async function getOwnerViews(ownerId: string): Promise<number> {
  try {
    await flushBeforeRead();
    const redis = getRedisClient();
    const val = await redis.get(`${KEY_VIEWS_OWNER}${ownerId}`);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

export async function getOwnerClicks(ownerId: string): Promise<number> {
  try {
    await flushBeforeRead();
    const redis = getRedisClient();
    const val = await redis.get(`${KEY_CLICKS_OWNER}${ownerId}`);
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

export type CounterSnapshot = {
  key: string;
  value: number;
};

async function scanKeys(pattern: string, redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== '0');
  return keys;
}

/** @deprecated Debugging only. Loads all keys into memory — use worker's batched snapshot instead. */
export async function getAllCounters(): Promise<CounterSnapshot[]> {
  try {
    await flushBeforeRead();
    const redis = getRedisClient();
    const viewKeys = await scanKeys('prop:views:*', redis);
    const clickKeys = await scanKeys('prop:clicks:*', redis);
    const allKeys = [...viewKeys, ...clickKeys];
    if (allKeys.length === 0) return [];
    const values = await redis.mget(...allKeys);
    return allKeys.map((key, i) => ({
      key,
      value: parseInt(values[i] || '0', 10),
    }));
  } catch {
    return [];
  }
}
