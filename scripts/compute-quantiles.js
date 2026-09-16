#!/usr/bin/env node
/**
 * P5 nightly quantile compute (traceable code path, no direct CMD/DB edits).
 * Calls POST /api/cron/compute-quantiles with CRON_SECRET.
 * Usage: CRON_SECRET=xxx node scripts/compute-quantiles.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3000';
async function main() {
  const res = await fetch(`${BASE}/api/cron/compute-quantiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}) },
  });
  const json = await res.json().catch(() => ({}));
  console.log(`quantiles: HTTP ${res.status}`, JSON.stringify(json));
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
