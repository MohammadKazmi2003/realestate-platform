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

const mapRatelimit = new Ratelimit({
  redis: getRedisClient(),
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  analytics: false,
  prefix: 'rl:map',
});

const autocompleteRatelimit = new Ratelimit({
  redis: getRedisClient(),
  limiter: Ratelimit.slidingWindow(120, '60 s'),
  analytics: false,
  prefix: 'rl:autocomplete',
});

// Locality boundary lookups hit Nominatim, which allows at most 1 req/s from an
// application; the route caches misses for 30 days and paces upstream calls,
// so this per-IP limit only rations the cheap cache-hit path.
const placeGeoRatelimit = new Ratelimit({
  redis: getRedisClient(),
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  analytics: false,
  prefix: 'rl:placegeo',
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

export async function checkMapRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  try {
    const result = await mapRatelimit.limit(identifier);
    return {
      allowed: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch {
    return { allowed: true, remaining: 0, reset: 0 };
  }
}

export async function checkAutocompleteRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  try {
    const result = await autocompleteRatelimit.limit(identifier);
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

export async function checkPlaceGeoRateLimit(identifier: string): Promise<{
  allowed: boolean;
  remaining: number;
  reset: number;
}> {
  try {
    const result = await placeGeoRatelimit.limit(identifier);
    return {
      allowed: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch {
    return { allowed: true, remaining: 0, reset: 0 };
  }
}
