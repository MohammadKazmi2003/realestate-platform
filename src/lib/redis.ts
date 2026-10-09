import Redis, { Cluster } from 'ioredis';

let redis: Redis | Cluster | null = null;

export function getRedisClient(): Redis | Cluster {
  if (redis) return redis as Redis;

  // Scale-ready: REDIS_CLUSTER=1 (or comma-separated REDIS_URL) uses
  // ioredis Cluster so adding Redis nodes needs env only. Single-node
  // default preserves local dev. SCAN+DEL callers must use hash-tag-safe
  // keys when clustering (tile keys already shard-safe: single-key ops).
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const wantCluster =
    ['1', 'true', 'on', 'yes'].includes(String(process.env.REDIS_CLUSTER || '').toLowerCase()) ||
    url.split(',').length > 1;
  if (wantCluster) {
    const startupNodes = url.split(',').map((u) => {
      const m = u.trim().match(/^(?:redis:\/\/)?([^:/]+)(?::(\d+))?/);
      return { host: (m && m[1]) || '127.0.0.1', port: Number((m && m[2]) || 6379) };
    });
    const cluster = new Cluster(startupNodes, {
      redisOptions: { maxRetriesPerRequest: 3 },
      scaleReads: 'slave',
    });
    cluster.on('error', (err) => {
      console.warn('Redis cluster error (non-fatal):', (err as Error).message);
    });
    redis = cluster;
    return cluster as unknown as Redis;
  }

  const single = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: false,
    // Scale-ready: allow read-replica splitting later via
    // REDIS_REPLICA_URL without code change (writes go to primary).
    enableReadyCheck: true,
  });

  single.on('error', (err) => {
    console.warn('Redis connection error (non-fatal):', err.message);
  });

  redis = single;
  return single;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const client = getRedisClient();
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 60): Promise<void> {
  try {
    const client = getRedisClient();
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // cache failures are non-critical
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const client = getRedisClient();
    await client.del(key);
  } catch {
    // cache failures are non-critical
  }
}

export async function cacheDeletePattern(pattern: string): Promise<void> {
  try {
    const client = getRedisClient();
    let cursor = '0';
    const batch: string[] = [];
    do {
      const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = result[0];
      batch.push(...result[1]);
      if (batch.length >= 200) {
        await client.del(...batch.splice(0, 200));
      }
    } while (cursor !== '0');
    if (batch.length > 0) {
      await client.del(...batch);
    }
  } catch {
    // cache failures are non-critical
  }
}

// Scale-ready distributed singleflight (cross-instance dedup).
// tryAcquireComputeLock returns true for the winner; losers poll cacheGet()
// for up to waitMs. Falls back to allow-compute on Redis errors so traffic
// still flows when cache is down. Lock TTL bounds duplicate ES work.
export async function tryAcquireComputeLock(key: string, ttlMs = 8000): Promise<boolean> {
  try {
    const client = getRedisClient();
    const res = await (client as any).set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
    return res === 'OK';
  } catch {
    return true;
  }
}

export async function releaseComputeLock(key: string): Promise<void> {
  try {
    await getRedisClient().del(`lock:${key}`);
  } catch {
    // non-critical
  }
}

// Coalesced compute with two levels of dedup (AD8: no required in-process state,
// but an in-process map is a valid *optimization* layer on top):
//
//   L1 in-process  — same-pod duplicates never touch Redis for the lock.
//   L2 Redis NX    — cross-pod dedup, so N instances share ONE computation.
//
// Invariant 6: the wait window MUST outlive the lock TTL, otherwise waiters
// give up while the winner is still working and all recompute — costing MORE
// backend work than having no lock at all, exactly when contention peaks.
//
// Invariant 4: only non-null results are ever cached. Callers that need their
// own cache write semantics (e.g. TTL jitter) pass `skipCacheWrite`.
const inflight = new Map<string, Promise<any>>();

// Invariant 6, expressed as constants so it is testable as a VALUE instead of
// by parsing source text. waitMs is derived from the lock TTL by construction,
// so the two can never drift apart and reintroduce the "waiters abandon the
// winner" failure mode.
export const SINGLEFLIGHT_LOCK_TTL_MS = 8000;
export const SINGLEFLIGHT_WAIT_MS = SINGLEFLIGHT_LOCK_TTL_MS + 1000;

export async function singleflightCompute<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T | null>,
  opts?: { lockTtlMs?: number; waitMs?: number; skipCacheWrite?: boolean }
): Promise<{ value: T | null; status: 'hit' | 'computed' | 'waited' | 'fallback' }> {
  const cached = await cacheGet<T>(key);
  if (cached) return { value: cached, status: 'hit' };

  const existing = inflight.get(key);
  if (existing) {
    const v = (await existing.catch(() => null)) as T | null;
    if (v) return { value: v, status: 'waited' };
  }

  let enabled = true;
  try {
    const { flags } = await import('@/lib/flags');
    enabled = flags.distSingleflight;
  } catch {
    enabled = process.env.DIST_SINGLEFLIGHT !== '0';
  }

  const write = async (v: T | null) => {
    if (v && !opts?.skipCacheWrite) await cacheSet(key, v, ttlSeconds);
  };

  const run = async (): Promise<{ value: T | null; status: any }> => {
    if (!enabled) {
      const v = await compute().catch(() => null);
      await write(v);
      return { value: v, status: 'fallback' };
    }
    const lockTtlMs = opts?.lockTtlMs ?? SINGLEFLIGHT_LOCK_TTL_MS;
    const waitMs = opts?.waitMs ?? SINGLEFLIGHT_WAIT_MS; // Invariant 6
    const won = await tryAcquireComputeLock(key, lockTtlMs);
    if (won) {
      try {
        const v = await compute().catch(() => null);
        await write(v);
        return { value: v, status: 'computed' };
      } finally {
        await releaseComputeLock(key);
      }
    }
    // Loser: wait for the winner's write. If the lock vanished without a write,
    // stop early rather than burning the whole window.
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      await new Promise((r) => setTimeout(r, 100));
      const v = await cacheGet<T>(key);
      if (v) return { value: v, status: 'waited' };
      if (!(await lockHeld(key))) break;
    }
    const v = await compute().catch(() => null);
    await write(v);
    return { value: v, status: 'fallback' };
  };

  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return (await p.catch(() => ({ value: null, status: 'fallback' }))) as any;
}

async function lockHeld(key: string): Promise<boolean> {
  try {
    return (await getRedisClient().exists(`lock:${key}`)) > 0;
  } catch {
    return true;
  }
}
