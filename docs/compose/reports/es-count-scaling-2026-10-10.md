# ES Counting at Scale — Investigation & Recommendation

- **Date**: 2026-10-10
- **Question**: is the shipped exact-count strategy (`track_total_hits: true` + `by_entity_type` terms, `NATIVE_COUNTS=1`) already optimal, or can it be significantly faster at scale?
- **Method**: code audit (read-only) + live ES benchmarks on 100k/1M corpora (cache-controlled, medians, concurrency, shards, index sorting) + ES internals and marketplace research
- **Answers**:
  1. The shipped strategy is the fastest **inline** exact strategy — but inline is the wrong frame at scale.
  2. A **split count path** (list `tth:false` + a `size:0` count request, batched in one `_msearch`) is **2–3.5× faster at 1M and ~3× the throughput under concurrency**, with byte-identical exact counts.
  3. **Nodes buy throughput, not latency.** Capping and approximation buy nothing.
- **Status**: **implemented** (2026-10-10) — see §10. All benchmark scratch indices/aliases/servers cleaned up; primary cluster verified intact.

---

## 1. Measured: the shipped inline strategy is optimal *within its frame*

Cache-controlled (query cache cleared + primed per strategy), median `took`, n=15:

| 1M scenario (matches) | counters×3 (old) | filters×2 | tth only | **tth+terms (shipped)** | terms only | tth+filters | capped 10k | cardinality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ALL (1,001,407) | 153 | 97 | 36 | **52** | 54 | 69 | 58 (`gte 10000`) | 165 (−0.46% error) |
| DUBAI (811,281) | 141 | 93 | 33 | **43** | 51 | 58 | — | — |
| TYPE (16,225) | 31 | 21 | 17 | **19** | 31 | 18 | — | — |

- No faster **exact inline** variant exists among filters agg, terms-only, `execution_hint:map`, or cardinality.
- Capping to 10k does **not** reduce time (58 vs 52 ms — the pass is identical) and only replaces `eq` with `gte`.
- Cardinality is slower **and** wrong (−0.46% on 1M, +2.4% on a 16k set).

## 2. Measured discovery: counting is only cheap when the request is count-only

Size ladder, 1M both indices, ALL, warm filter bitsets (`took`/wall ms):

| Shape | took | wall |
| --- | --- | --- |
| size:0, `tth:false`, no aggs | 0 | 4.4 |
| size:0, `tth:true`, no aggs | 0 | 2.8 |
| size:0, `tth:true` + terms | 7 | 11.6 |
| size:1, `tth:true` | 32 | 35.3 |
| size:24, `tth:true` | 53 | 57.7 |
| size:24, `tth:false` + terms | 74 | 78.5 |
| size:24, `tth:true` + terms (shipped) | 63 | 67.4 |

Mechanism (documented + corroborated): a count-only request goes through Lucene's `IndexSearcher.count` / `Weight.count`, which returns **sub-linear** counts where the query supports it; the moment a top-k collector exists, every match is counted/aggregated in the collector pass. This is why adding exact counting to a `size:24` query costs +32–68 ms at 1M while the same count as a separate `size:0` request costs 1–10 ms.

**Interleaved A/B, n=30, warm bitsets, p50 wall ms:**

| Scenario | inline (1 trip) | split sequential (2 trips) | **split `_msearch` (1 trip)** |
| --- | --- | --- | --- |
| ALL (1.0M) | 102 | 49.3 | **31.7** |
| DUBAI (811k) | 90.7 | 44.9 | **29.5** |
| PRICE (440k) | 50.6 | 37.9 | **25.8** |
| TYPE (16k) | 42.4 | 50.6 | 42.2 (wash) |
| 100k ALL | 21.2 | — | **13.1** |

Count parity verified `eq`/identical in every scenario. **Crossover ≈ 80–100k matches.**

**Concurrency (DUBAI, 64 req/level, no rejections):**

| Variant | conc 8 | conc 16 |
| --- | --- | --- |
| inline (shipped) | 86.4 QPS, p50 79 ms | 51.9 QPS, p50 263 ms |
| count-only `size:0` | 138.2 QPS | 145.5 QPS |
| list-only | 119.2 QPS | 107.2 QPS |
| **`_msearch` split** | 107.2 QPS | **180.3 QPS, p50 78 ms** |

## 3. Measured: cache and index-structure effects

- Count-only `tth:true`+terms: uncached 5–10 ms; request-cache miss (cold bitsets) 25 ms; **request-cache hit 1 ms**; `_count` API warm ~5 ms.
- Request cache covers only `size:0` requests and invalidates on refresh **when data changed** — in production it absorbs repeats between writes; the app's Redis response cache already covers repeats for 60–300 s.
- **Index sorting** (`index.sort.field: created_at desc`) helps the list fetch (28 → 5 ms) but leaves counts unchanged (16 → 16 ms) and costs indexing throughput + a reindex. Not a counting optimization.
- Node query cache (filter bitsets) is what makes repeated filters cheap; it is already active.

## 4. Measured: shard scaling and the node verdict

1M projects, DUBAI, inline S5:

| Shards (one node) | latency `took` | conc8 | conc16 | conc32 | queue peak @32 |
| --- | --- | --- | --- | --- | --- |
| 1 | 49 ms | 44.6 | 53.4 | 59.5 | 19 |
| 2 | 43 ms | 55.9 | 53.5 | 50.6 | 48 |
| 4 | **26 ms** | 39.1 | 48.1 | 61.4 | 97 |
| 6 | 34 ms | 37.3 | 42.9 | 57.6 | 107 |

- More shards parallelize a **single** query (49→26 ms) but add **no throughput** on one node (fixed CPU) and inflate the search queue 5×.
- **Verdict — nodes = throughput, not latency.** A query waits for its slowest shard + coordination; a 1-shard index cannot be parallelized across nodes. Nodes reduce latency only if indices are also re-sharded so fan-out has capacity (and fan-out then multiplies shard-queries 1→N).
- The 2-node measurement was attempted and aborted: a capacity-matched temp cluster caused host memory pressure and the primary ES container restarted once (recovered automatically; data/aliases verified intact). That verdict is therefore partly **theoretical**, supported by the shard measurements and ES/Lucene docs.

## 5. Research context (cited)

- `track_total_hits` exact counting "visits all matches"; default 10k `gte` — ES docs. `Weight.count` default −1 = "could not be computed in sub-linear time"; `IndexSearcher.count` may use index statistics — Lucene javadoc. `_count` = search with `size:0`.
- Request cache: only `size=0`; invalidates on refresh only if data changed — ES docs. Node query cache: filter bitsets, 10% heap LRU.
- Shard sizing: one search thread per shard, more shards = more overhead; replicas increase count scalability — ES docs.
- Marketplace practice: Zillow caps pagination/markers and uses recursive map-tile quadrant splitting (map-first, no deep pagination); Booking rounds global totals; Redfin precomputes national counts. Our measurements show capping would save **no** query time, so exact counts are affordable.

## 6. Code-level findings that change the priority (read-only audit)

1. **Counts are recomputed on every paginated page**: the list key includes `cursor` (`filterNormalize.ts:412-413`) and `/api/search`'s key includes cursor (`search/route.ts:65`), so every Load More pays the full count + `by_entity_type` pass (and single-scope facets in `/api/search`, which are page-invariant).
2. **`/api/search` duplicates filter construction** instead of using `buildFilters` (AD3): no `entity_type` scope constraint, `price` instead of `low_price` for projects, `minBedrooms/maxBedrooms` ignored — counting can describe a different population than map-data.
3. **`request_cache: true` params are currently no-ops**: no app index sets `index.requests.cache.enable` (ES default false). The intent exists in five call sites; it does nothing.
4. **`MSEARCH_ENABLED` is declared but unused** — the split path would be its first real use.
5. **`GEO_ROUTING` is a latent correctness bug**, not an optimization: routing params are sent on tile/fill searches but docs are not indexed with routing. On a multi-shard index a routing value prunes to one shard and silently drops matches. Harmless today only because every index is 1 shard. Must be fixed or gated before any re-shard.
6. Empty viewports are cached on `/api/map-data` (`[]` is truthy in `singleflightCompute`) while `/api/map-tiles` refuses — inconsistent Invariant-4 behavior.

## 7. Recommended architecture

**Keep exact counts. Split counting from the list fetch at scale. Fix the placement issues before touching infrastructure.**

1. **`SPLIT_COUNTS` flag (default off initially, env-revertible per AD7)**:
   - list request: `track_total_hits:false`, no count aggs;
   - count request: `size:0`, `track_total_hits:true` (+ `by_entity_type` terms only for `scope=both`), same `buildFilters` population (AD3);
   - both issued as **one `_msearch`** so the HTTP round trip and key semantics are unchanged. Counts stay exact (`eq`, parity verified).
   - Roll out per market by size (AD9): measured crossover ~80–100k matches; below it inline and split are within noise.
2. **Count-only Redis cache keyed by normalized filters (no cursor, no sort)** for deep pagination — counts are page- and sort-independent; only worth it if cursor-page volume is material (ES request cache already gives ~1 ms repeats).
3. **Consolidate `/api/search` onto `buildListQuery`/`buildFilters`** — removes the population drift and gives one counting implementation.
4. **Do not**: cap, approximate, add shards for throughput on one node, or add nodes expecting latency gains.
5. **Later, at 10M+**: re-shard (3–6 shards) across ≥2 nodes so fan-out has capacity; fix `GEO_ROUTING` first. Index sorting only for the dominant `newest` sort, and only if list-fetch latency matters after counting is split.

Expected effect at 1M on this node: cold list+count 90–102 ms → 25–32 ms p50; sustained QPS ~3×. Cost: one flag + a second query shape + msearch parsing; no infra, mapping, or reindex required; revert is one env var.

## 8. Measured vs theoretical

- **Measured**: all strategy/size-ladder/A-B/concurrency/shard/cache/index-sort numbers above; `_count`/`_msearch` request-cache behavior; count parity; the ES container restart event.
- **Theoretical (docs + inference)**: node scaling latency-vs-throughput verdict (2-node test aborted for stability); projections beyond 1M; Lucene collector internals (corroborated by the size ladder, not source-traced); marketplace UX claims (external sources).

## 9. Limits

- 512 MB heap, single node, 1 shard/index, replicas unassigned; host under load 9–12 during benchmarks — absolute latencies are upper bounds, rankings are the transferable result.
- Synthetic lean-mapping corpora (no analyzers/text queries), 7/93 property/project split, jittered copies; the real 1.5k dataset is <5 ms everywhere.
- Shard copies differed in segment counts; sorted/unsorted tests used force-merged indices.
- Count-only sub-linearity depends on query shape (term/range/geo tested; script filters untested).

---

## 10. Implementation (shipped 2026-10-10)

**What changed**

| File | Change |
| --- | --- |
| `src/lib/flags.ts` | `splitCounts` (`SPLIT_COUNTS`, default ON, env-revertible). `NATIVE_COUNTS` / `EXACT_COUNT_COUNTERS` / `LIST_CAP_10K` remain as inline fallbacks. |
| `src/lib/esQueryBuilder.ts` | New `buildCountCacheKey` (population-only key), `buildCountQuery` (`size:0`, exact, entity split for `scope=both`, `request_cache` on), `parseListingCounts`, `getListingCountsFor` (Redis singleflight L1+L2 + tiered TTL, degrades to one uncached attempt), `getListingCounts`; `buildListQuery` runs `tth:false` with no count aggs in split mode; `queryESListings` runs list + cached count in parallel and reads exact totals from the count. |
| `src/app/api/search/route.ts` | Population now built by `buildFilters` (fixes the drift: missing `entity_type` scope constraint, `price` instead of `low_price` for projects, `minBedrooms` ignored) and `indexForScope` (projects scope no longer queried the properties alias); split counts + the same cached count path; empty-state count rides the same cache instead of the fragile substring-filtered `es.count`. |
| `src/__tests__/countStrategy.test.ts` | 9 tests pinning split/inline/fallback shapes, count-query shape, parsing, and the page/sort-invariant cache key. |

**The count cache (the reuse contract)**

- Key: `md:v5:c:{buildFilterHash64({must, filters})}` — the **filter population only**. No cursor, sort, or pageSize, because counts are page- and sort-invariant. Every Load-More page and every re-sort of the same population reuses one cached count; the list response cache (keyed with cursor+sort) cannot provide that reuse.
- Coalescing: `singleflightCompute` (in-process L1 + Redis SET NX L2), tiered TTL via `redisTTLForSort`, failures never cached.
- ES side: `request_cache: true` on the count request (the shard request cache serves `size:0` only), so even a Redis miss can be served by ES at ~1 ms.

**Measured after implementation**

ES-level, interleaved, warm bitsets, 1M corpora (median wall ms):

| Scenario | inline (`SPLIT_COUNTS=0`) | list-only | count-only | **split (list ∥ count)** |
| --- | --- | --- | --- | --- |
| DUBAI (811k) | 102.0 | 50.2 | 12.9 | **51.5 (−50%)** |
| ALL (1.0M) | 100.3 | 34.4 | 11.4 | **43.4 (−57%)** |

Count cache behavior (real dataset, `/api/search`, ES shard-query deltas per call):

| Call | split+cache | inline |
| --- | --- | --- |
| cold (cache flushed) | 4 (list 2 + count 2) | 2 (counting inline) |
| re-sort (same population) | **2 (count cache HIT)** | 2 |
| page 2 (cursor) | **2 (count cache HIT)** | 2 |

App-level `/api/search` (1M, cold per request, interleaved): DUBAI 160 vs 197 ms p50 (−19%); ALL 113 vs 111 ms (wash). Route/Next overhead (~70–100 ms on this contended host) and p99 variance mask much of the ES-level gain end-to-end; the ES-level delta is the transferable number. On `map-data`, route latency at 1M is dominated by the marker fill query, so the counting gain shows primarily on the list path and on warm count reuse.

**Verification**

- `npm run test:ci`: **17 suites / 141 tests PASS**.
- Count parity split+cache vs inline: **19/19** real-data scenarios (scopes, prices, types, intent, amenities, sorts, Dubai/India/empty, cursor page 2, polygons, `/api/search`).
- `npm run scale:e2e`: **50/50 PASS**; cold 7.20 shard-queries/request (the count adds one cheap pass on cold), warm **0**, all scope/cache/edge invariants hold.
- 1M count parity: identical totals/splits across DUBAI/INDIA/ALL.

**Not done (evidence does not justify it yet)**

- `_msearch` batching of list+count into one round trip (the agent measured ~20 ms better than sequential at 1M locally). With the count cache warm, most requests are list-only anyway, so the parallel+ cache design was chosen for simplicity and cross-instance coalescing. Revisit if cold-burst throughput becomes the constraint.
- Capping/approximate counts (no measured benefit), node scaling for latency (throughput only).

