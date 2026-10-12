// Flush app response-cache prefixes (md:v5 list/markers/tiles/counts, pg:v2
// pills, q:v2 quantiles, s: search-page cache). Used between corpora and
// before every cold measurement. NEVER touches rl:* (rate limiter) or locks.
//
// Usage: node scripts/flush-app-cache.mjs [--prefixes=md:v5:,pg:v2:,q:v2:,s:]
import 'dotenv/config';
import Redis from 'ioredis';

const prefixes = String(
  process.argv.find((a) => a.startsWith('--prefixes='))?.split('=').slice(1).join('=') ||
  'md:v5:,pg:v2:,q:v2:,s:'
).split(',');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 2 });
let cursor = '0';
let deleted = 0;
let scanned = 0;
const byPrefix = {};
do {
  const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
  cursor = next;
  scanned += keys.length;
  const toDel = keys.filter((k) => prefixes.some((p) => k.startsWith(p)));
  if (toDel.length) {
    for (const k of toDel) {
      const p = prefixes.find((x) => k.startsWith(x));
      byPrefix[p] = (byPrefix[p] || 0) + 1;
    }
    await redis.del(...toDel);
    deleted += toDel.length;
  }
} while (cursor !== '0');
console.log(`scanned=${scanned} deleted=${deleted}`, JSON.stringify(byPrefix));
await redis.quit();
