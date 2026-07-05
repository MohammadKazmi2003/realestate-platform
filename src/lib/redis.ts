import Redis from 'ioredis';

let redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (redis) return redis;

  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: false,
  });

  redis.on('error', (err) => {
    console.warn('Redis connection error (non-fatal):', err.message);
  });

  return redis;
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
