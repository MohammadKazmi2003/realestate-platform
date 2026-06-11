import { Ratelimit } from '@upstash/ratelimit';
import { getRedisClient } from './redis';

const globalRatelimit = new Ratelimit({
  redis: getRedisClient(),
  limiter: Ratelimit.slidingWindow(30, '60 s'),
  analytics: false,
  prefix: 'rl:global',
});

const searchRatelimit = new Ratelimit({
  redis: getRedisClient(),
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  analytics: false,
  prefix: 'rl:search',
});

export async function checkRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  try {
    const result = await globalRatelimit.limit(identifier);
    return {
      allowed: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch {
    return { allowed: true, remaining: 0, reset: 0 };
  }
}

export async function checkSearchRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  try {
    const result = await searchRatelimit.limit(identifier);
    return {
      allowed: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch {
    return { allowed: true, remaining: 0, reset: 0 };
  }
}

export function getRateLimitIdentifier(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  return `ip:${ip}`;
}
