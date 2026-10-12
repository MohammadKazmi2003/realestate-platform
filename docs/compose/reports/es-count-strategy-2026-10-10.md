# ES Counting Strategy — Benchmark & Implementation

> **Follow-up (2026-10-10)**: this report established the fastest **inline** exact strategy. A subsequent scale investigation (`es-count-scaling-2026-10-10.md`) measured that splitting the count into a `size:0` request (`_msearch` with the list query) is 2–3.5× faster at 1M matches with identical exact counts, because count-only queries use Lucene's sub-linear `Weight.count` path while a `size>0` query counts every match in the top-k collector.

- **Date**: 2026-10-10
- **Scope**: matching-listing counts for the browse/map list query (`scope=both` properties+projects), used for sidebar totals and scope badges
- **Method**: live ES `profile`-grade measurements on synthetic 100k and 1M corpora built from the real indices (jittered copies, lean `listings_tile` mapping, 7% properties / 93% projects), plus end-to-end route measurements with read aliases temporarily swapped to the corpora, plus correctness parity against the real dataset
- **Revision before change**: `8f93db0` (three `filter→value_count` counters, `track_total_hits: false`)

---

## 1. Recommendation

**Use `track_total_hits: true` + a `by_entity_type` terms aggregation (size 2), and delete the counter aggregations.**

- It is the fastest exact strategy measured at both 100k and 1M, across five filter selectivities.
- `track_total_hits: true` is effectively free: counting is an integer increment on the matching pass the query already performs for the 24 hits. The terms agg adds one ordinal pass over a 2-value keyword.
- Each `filter→value_count` counter re-evaluates the **full base filter** (a separate collector pass), so the current three-counter design pays for the matching work three extra times.
- Exactness is preserved: `hits.total` is exact at every scale (no cap/truncation/shard pre-trim), and the terms agg gives the property/project split.

Shipped behind `NATIVE_COUNTS` (default on; `NATIVE_COUNTS=0` restores the counter path without a code revert — AD7).

---

## 2. Measured results

### 2.1 Strategy comparison, 100k corpus (median `took`, ms; n=15; filter cache cleared + primed identically per strategy)

| Scenario (matches) | S1 counters×3 (current) | S2 filters×3 | S3 filters×2 | S4 tth only | **S5 tth+terms** | S6 terms only | S7 tth10k+terms | S8 tth+filters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ALL (100,295) | 26 | 31 | 18 | 9 | **10** | 12 | 11 (capped) | 13 |
| INDIA props (7,020) | 5 | 6 | 6 | 4 | **5** | 8 | 4 | 3 |
| DUBAI projects (81,232) | 22 | 20 | 15 | 6 | **7** | 18 | 10 (capped) | 13 |
| price ≥ p95 (4,974) | 10 | 9 | 10 | 14 | **8** | 12 | 8 | 8 |
| property_type (1,625) | 7 | 8 | 17 | 10 | **8** | 8 | 7 | 7 |
| bbox+price+type (1,089) | 6 | 6 | 5 | 3 | **4** | 5 | 6 | 5 |

### 2.2 Strategy comparison, 1M corpus (median `took`, ms; n=15; cache-controlled)

| Scenario (matches) | S1 counters×3 | S2 filters×3 | S3 filters×2 | S4 tth only | **S5 tth+terms** | S6 terms only | S7 tth10k+terms | S8 tth+filters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ALL (1,001,407) | 218 | 188 | 127 | 59 | **83** | 72 | 92 (capped) | 87 |
| INDIA props (70,092) | 22 | 25 | 17 | 7 | **8** | 9 | 8 (capped) | 10 |
| DUBAI projects (811,281) | 160 | 117 | 131 | 47 | **73** | 57 | 57 (capped) | 68 |
| price ≥ p95 (49,220) | 45 | 38 | 38 | 40 | 41 | 33 | 36 (capped) | 32 |
| property_type (16,225) | 29 | 35 | 30 | 19 | **21** | 25 | 20 (capped) | 20 |
| bbox+price+type (9,614) | 17 | 19 | 18 | 14 | **15** | 13 | 12 (capped) | 17 |

Findings:

- **S1 → S5 is 2.6× faster at 1M all-matches (218 → 83 ms) and 2.6× at 100k (26 → 10 ms).** The redundant `exact_total` counter alone costs ~90 ms at 1M (S1 218 vs S3 127).
- **`track_total_hits: true` is free**: S4 (59 ms) vs a no-count query is within noise; the counting increment rides the same pass.
- **Capping does not help**: S7 (`track_total_hits: 10000`) costs the same as S5 (92 vs 83 ms — noise) because the query pass is identical; it only replaces exactness with `gte`. There is no latency case for capped counting.
- **S6 (terms only, total = bucket sum) is 11–16 ms cheaper than S5 at 1M** but loses the authoritative total: a document with a missing/other `entity_type` would silently drop out of the sum. S5 keeps `hits.total` exact while still giving the split — the safer choice at a small measured cost.
- S8 (keyed filters agg) is competitive but noisier and does not beat S5 on the heavy all-matches scenarios.

### 2.3 End-to-end at 1M (aliases temporarily pointed at the corpora; cold list per request; 10 samples)

| Scenario (matches) | native p50 / p99 / mean | counters p50 / p99 / mean | Counts |
| --- | --- | --- | --- |
| DUBAI z10 (821,394) | **182 / 321 / 193 ms** | 281 / 443 / 316 ms | MATCH |
| INDIA z8 (70,092) | **55 / 116 / 59 ms** | 63 / 109 / 67 ms | MATCH |
| ALL z6 (1,001,407) | **214 / 522 / 235 ms** | 351 / 497 / 353 ms | MATCH |

**−35% p50 on the heavy project population, −39% on the full 1M population**, with byte-identical counts and 24 sidebar results. The route delta is smaller than the raw ES delta because the request also pays tile fan-out and serialization; the list query is the largest single component on cold views.

### 2.4 Concurrency

- Concurrent cold at 1M (native, first genuinely cold run, conc 10, n=100): **42 QPS, p50 179 ms, p99 1.48 s, 0 errors, ES pool `queue=0 active=0/13 rejected=0`**. Later runs in the same session hit cache (ES/req 0) and are warm-path numbers, not cold.
- Warm path is unchanged by this work: cached list+markers = **0 ES searches**, p50 ~8 ms (audit baseline). Counting is computed once per cached union+filters entry.

### 2.5 The sub-10 ms target, honestly

| Population matched | Native count time (1M corpus) |
| --- | --- |
| ~9.6k (bbox+price+type) | 15 ms |
| ~16k (type) | 21 ms |
| ~49k (price ≥ p95) | 41 ms |
| ~70k (all properties) | 8 ms |
| ~811k (all projects) | 73 ms |
| ~1.0M (everything) | 83 ms |

- Sub-10 ms is achieved for filtered populations up to roughly 100k matches on this node (INDIA 70k = 8 ms; 100k all-matches = 10 ms). Typical viewport filters are in this band.
- For filters matching hundreds of thousands to millions, **exact counting cannot be sub-10 ms on this hardware**: the base matching pass alone is 47–59 ms at 1M and any count must at least visit the matches. The levers that get a user under 10 ms at that scale are (a) the response cache — already in place, warm = 0 ES / ~8 ms — and (b) narrower viewports/filters. Approximate or capped counting does **not** reduce query time (S7 ≈ S5), so it buys nothing; precomputed/cached counts are the only sub-10 ms path for global filters, and the existing TTL cache already provides it for repeat traffic.

---

## 3. Correctness verification

| Check | Result |
| --- | --- |
| `npm run test:ci` | **17 suites / 137 tests PASS** (5 new counting-strategy tests) |
| Count parity, native vs counters, real data (19 scenarios: scopes, price, type, BHK, intent, amenities, sorts, Dubai/India/empty, pagination cursor, polygons, `/api/search`) | **19/19 identical** totals, relations, property/project splits |
| Count parity at 1M (3 scenarios) | identical totals/splits/results |
| `npm run scale:e2e` | **50/50 PASS** (scope isolation, totals, caching, edge) |
| Revert path | `NATIVE_COUNTS=0` restores counters; `NATIVE_COUNTS=0 EXACT_COUNT_COUNTERS=0` restores capped counting; both pinned by tests |

---

## 4. Implementation

- `src/lib/flags.ts` — new `nativeCounts` (`NATIVE_COUNTS`, default ON).
- `src/lib/esQueryBuilder.ts` — new exported pure `buildListQuery(params)` selects the strategy and is used by `queryESListings`:
  - native: `track_total_hits: true`, `by_entity_type` terms for `scope=both`, no counter aggs;
  - fallback: counters (`EXACT_COUNT_COUNTERS`) or capped counting (`LIST_CAP_10K`).
- `src/app/api/search/route.ts` — same strategy selection for the append/search path.
- `src/__tests__/countStrategy.test.ts` — pins native shape, single-scope shape, both revert paths, pagination tiebreaker.
- `scripts/bench-count-strategies.js` — reproducible strategy benchmark (cache-controlled; counts compared across strategies).

Revert without a deploy: `NATIVE_COUNTS=0`.

---

## 5. Remaining notes

- The `by_entity_type` terms agg is only added for `scope=both`; single-scope queries count with `track_total_hits: true` alone.
- The quantile threshold computation and lazy pills remain off the list path (AD4/AD6) — unchanged.
- Numbers were taken on a single ES node with a 512 MB heap; the *relative* strategy ranking is what transfers, and the absolute 1M figures should be re-measured on a production cluster (shards/replicas/heap) before capacity sizing.
- Synthetic corpora use the lean `listings_tile` mapping (no analyzers); the counting clauses and sort are identical to production, and text queries were excluded (they are a minority of browse pans and do not change the counting cost).
