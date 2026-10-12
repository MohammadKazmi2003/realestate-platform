# `/browse` End-to-End Elasticsearch Performance — Analysis & Benchmarks

- **Date**: 2026-10-10
- **Revision measured**: `8f93db0` + working-tree changes: split counts
  (`src/lib/esQueryBuilder.ts`, `src/app/api/search/route.ts`, `src/lib/flags.ts`),
  env-overridable read indices + env-gated `Server-Timing`
  (`src/lib/elasticsearch.ts`, `src/lib/routeTiming.ts`), benchmark scripts in
  `scripts/`, raw artifacts in `bench-results/`. Instrumentation is default-off
  or behavior-neutral.
- **Method**: production build; per-query ES `_profile:true` through the shipped
  builders; HTTP action matrix with `Server-Timing`; concurrency ladders with
  during-load sampling of ES thread pools / CPU / heap, app CPU/RSS and Redis;
  deterministic corpora at 100k / 1M / 5M docs (7/93 property/project split)
  plus a 6-shard variant at 100k; A/B count-strategy parity against direct-ES
  ground truth.
- **Labeling**: **measured** unless marked **extrapolated**, **code-verified**
  (read from source, not benchmarked), or **prior-measured** (earlier reports
  in this directory).

---

## 1. Executive summary

1. **Warm `/browse` traffic never touches Elasticsearch.** A full cache hit
   returns in 6–33 ms p50 (live 7 ms) with `es/req = 0` and 100% `X-Cache:
   list:HIT,markers:HIT` in every action and load scenario tested. The measured
   ceiling is the app/CDN layer, not ES: 484 QPS (live 17 KB payload) vs 81 QPS
   (100k corpus, 465 KB payload) on one instance, conc 10–25.
2. **Cold requests are bounded by design (≤ ~10 shard queries) but per-query
   cost scales with matching documents.** Measured cold `es/req`: 6.4–12.1
   across corpora and scenarios; no growth with corpus size. Per-query cost
   grows instead: country-view tile aggregation costs 1.5 ms CPU at 1.5k docs,
   66.9 ms at 100k, 594.6 ms at 1M, 3,033 ms at 5M — linear at ~0.6 ms CPU per
   1k matching docs.
3. **The tile aggregation (`geotile_grid` + `top_hits`) and its filter pass
   dominate all expensive queries**: ~48% query phase, ~52% collector phase at
   every volume. For the list query, cost is split between the filter pass
   (~45–53%), the top-k sort collector (~42–44%) and fetch (~3–47%, falling
   with volume on lean corpora).
4. **Exact counting**: split counts (`size:0`, `tth:true` + terms) cost 2.0 ms
   CPU at 100k, 9.9 ms at 1M, 46.3 ms at 5M. On page 1 the split list + count
   runs in parallel (list phase at 5M: 49.8 ms wall) — within noise of inline
   native counting (42.4 ms); its measured win is **reuse**: the count key has
   no cursor/sort, so every Load-More page and re-sort reuses it.
5. **Resource ceilings on this host are app-bound first on warm traffic and
   ES-bound on cold overview traffic.** During cold 5M loads: ES CPU peaked at
   82%, search queue at 183, **0 rejections**, heap ≤ 723 MB / 1 GB; the app
   process peaked at ~85% CPU and 330 MB RSS. During warm loads ES sat at ≤24%
   CPU while the app pegged >100–167% of a core serializing payloads.
6. **Sharding multiplies per-request work on one node.** A 6-shard 100k variant
   measured 35–50 shard queries/request (vs 6.4 on 1 shard, 5.5×) and lower
   throughput at low concurrency (26 vs 62 QPS at conc 10) — before any
   reshare, `GEO_ROUTING` must be gated (code-verified latent multi-shard bug)
   and fan-out batched.
7. **5M documents on this host required a 1 GB ES heap and conservative
   indexing; the first attempts wedged the container** (Docker VM 4 GB shared
   with the Supabase stack; two OOM events observed). That is a host-capacity
   finding, not an architectural limit.
8. **Parity holds**: split-count vs inline-count totals and marker sets were
   identical in 12/12 scenarios; ground truth was never greater than the served
   count (no narrowing); `test:ci` 141/141; `scale:smoke` PASS; `scale:e2e`
   50/50.

---

## 2. Environment, corpora, and method

| Item | Value |
| --- | --- |
| App | Next.js 15.5.25, production build; one instance per corpus on :3200 (live), :3210 (100k), :3211 (1M), :3212 (5M), :3213 (100k-6shard); split-off parity server on :3220 |
| ES | 8.15.0 single node, **1 GB heap** (Docker VM 3.8 GB shared with Supabase), 1 shard/index, replicas 0 |
| Redis | 7, 2 GB maxmemory, volatile-lru (Docker) |
| Live dataset | 108 properties + 1,435 projects; tile index 1,543 docs |
| Corpora | `bench_{props,projects,tile}_{100k,1m,5m}`; 100,295 / 1,001,407 / 5,000,863 tile docs; lean mapping (query fields only) |
| 6-shard variant | `bench_*_100k_s6` via server-side reindex |
| Host | macOS, 8 cores, ~8 GB RAM (Docker VM 3.8 GiB / 8 vCPU); app and load generator share the host |

Methods applied (per AGENTS.md “Verifying Claims”):

- Production build only; each corpus served by a dedicated instance with
  `ES_*_INDEX` env overrides (defaults unchanged) and `ROUTE_TIMING=1`
  (default-off instrumentation that adds a `Server-Timing` header).
- Distinct `x-forwarded-for` per request so the 60/min map limiter is not the
  measured component.
- ES backend work measured from shard-level `query_total` deltas
  (`_stats/search?level=shards`), never inferred from code.
- Thread pools / CPU / heap sampled **during** load every 500 ms.
- Cold measurements first flush app caches (`md:v5:`, `pg:v2:`, `q:v2:`, `s:`);
  in-profile measurements set `request_cache:false` for CPU attribution.
- Concurrency levels get fresh viewports (per-level offsets) so later levels do
  not replay earlier warmed URLs.
- Headline exclusions: text/autocomplete shapes were not profiled on lean
  corpora (no analyzed fields); pills `by_project` is unrepresentative because
  the lean mapping has no `project_name` (reported as 0.2 ms, ignore it).

### 2.1 Corpus stability finding (measured)

The first 1M tile build and the first 5M tile build each wedged ES with 2 GB
heap: GC-overhead warnings, thread-watchdog hot-thread dumps, client
connection failures; `docker inspect` reported `OOMKilled=true`. Root cause:
the 3.8 GiB Docker VM is shared with 11 Supabase containers (~1.2 GB), leaving
insufficient room for a 2 GB ES heap plus Lucene off-heap/page cache under
bulk-load spikes. Stable configuration used for all reported numbers:
**1 GB heap, 2,500 docs/bulk, periodic refresh, single merge thread**. No ES
instability was observed during any subsequent query/load phase.

---

## 3. Action → request trace (code-verified)

| User action | Client behavior | Endpoint(s) | ES work on miss | Measured ES queries |
| --- | --- | --- | --- | --- |
| Initial load | one `fetchAllProperties(map.getBounds())` after map `load` (`browse/page.tsx:1410-1462`) | `GET /api/map-data` (GET preferred; POST only for polygons/cursor) | ping (≤1/10 s) + list + count + tiles (1–8×≤2 attempts) + fill (0–1) + quantile (z<10, miss) | 8–14 |
| Pan/zoom (search-as-I-move) | 400 ms debounce, abort previous (`:1510-1519`) | `GET /api/map-data`, canonical tile-union bounds | same; union key reused within a tile set | 8–14 cold; 0 warm |
| Filter apply | 500 ms debounce (`:1653-1661`, `1754-1756`, `1615-1630`) | `GET /api/map-data` | same | 8–12 |
| Sort change | 500 ms debounce (`:2340-2365`) | `GET /api/map-data` (sort in key + sort bucket) | same; quantile field follows sort | 8 |
| Map ↔ List toggle | state only — **no request** (`:2308-2333`) | — | — | 0 |
| Load More | cursor from page 1 (`:1794-1819`) | `POST /api/search` or `POST /api/projects/search` | list + cached count | 2–4 (viewport); 4 (global) |
| Marker click | fetch-free from marker payload; gallery fetch only when incomplete (`:1267-1386`) | `GET /api/listings/{id}` (Supabase) | none | 0 |
| Autocomplete | 350 ms debounce + abort (`:405-444`) | `GET /api/search/autocomplete` | 1 ES multi_match + MapTiler (parallel) | 1 |
| Pills | non-blocking after list (`:844-868`) | `GET /api/project-groups` | one `by_project` terms agg | 1 |

Warm full-hit path: rate limit (1 Redis call), two parallel `cacheGet`s, JSON
serialization, CDN headers. **0 ES queries** — verified across all scenarios.

---

## 4. Query inventory and cache keys

| Query | Builder | Shape | Cache key / TTL |
| --- | --- | --- | --- |
| List | `buildListQuery` (`esQueryBuilder.ts:510`) | size 24, `tth:false` (split mode), indexed sort + `id` tiebreak, `_source` whitelist | `md:v5:l:*` + filter hash + pageSize + cursor; 60/120/300 s by sort tier |
| Count | `buildCountQuery` (`:432`) | size 0, `tth:true`, `by_entity_type` (scope both), `request_cache:true` | `md:v5:c:*` filter-population only — page/sort invariant |
| Tile markers | `buildTileAggQuery` (`esTileMarkers.ts:111`) | size 0, `geotile_grid` size 1000 / shard 1500, `top_hits:1`, `request_cache:true` | `md:v5:t:{z/x/y}:*` + filter + sort hash |
| Fill | `querySortFillForBounds` (`:440`) | size ≤500, indexed sort, `request_cache:true` | rides marker compute (uncached separately) |
| Legacy random markers | `queryESMapMarkers` (`esQueryBuilder.ts:660`) | `function_score random_score`, size 500 | `md:v5:m:*` |
| Pills | `queryESProjectGroups` (`:752`) | size 0, `by_project` terms | `pg:v2:*` (list hash), TTL ≥300 s |
| Quantile | `map-data/route.ts:188-216` | size 0, TDigest p50/p90, `request_cache:true` | `q:v2:{region}:{field}:{intent}`, 24–26 h |
| Load More | `/api/search` | list + count (shared builders) | `s:*` incl. cursor, 60 s; count via `md:v5:c:*` |

**Correction to a prior claim (measured):** `request_cache` is **not** a no-op
in ES 8.15 — `index.requests.cache.enable` defaults to `true`
(verified in `_settings?include_defaults=true`), and the tile index recorded
1,261 request-cache hits / 2,232 misses with 494 KB cache during profiling.
Size:0 paths (counts, tiles, fill, pills, quantiles) are therefore served from
the shard request cache on repeat within a refresh window, in addition to Redis.

---

## 5. Per-query phase breakdown (measured, `_profile`)

Legend: **wall** = HTTP round trip, **took** = ES wall; **shardCPU** = sum of
rewrite + query + collector + fetch durations across shard threads (they
overlap in wall time, so CPU can exceed `took`). Phase percentages are of
shardCPU. Rows are medians of 11 runs (7 for 5M), 2 warmups discarded.

### 5.1 Headline shapes across volumes

| Shape | Volume | wall ms | took ms | shardCPU ms | rewrite % | query % | collect % | fetch % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| list both/newest | 1.5k | 9.2 | 4 | 2.6 | 3.2 | 11.6 | 7.8 | **77.5** |
| list both/newest | 100k | 14.4 | 9 | 4.9 | 2.7 | 17.7 | 25.0 | 46.7 |
| list both/newest | 1M | 15.9 | 11 | 12.4 | 0.8 | 44.6 | 42.1 | 12.5 |
| list both/newest | 5M | 49.8 | 45 | 58.3 | 0.1 | 53.4 | 43.6 | 2.8 |
| count both (`tth:true` + terms) | 1.5k | 2.0 | 0 | 0.5 | 12.5 | 48.3 | 38.7 | 0 |
| count both | 100k | 7.3 | 3 | 2.0 | 10.6 | 54.2 | 35.1 | 0 |
| count both | 1M | 10.5 | 7 | 9.9 | 1.0 | 57.0 | 41.4 | 0 |
| count both | 5M | 35.6 | 32 | 46.3 | 0.2 | 58.3 | 41.5 | 0 |
| tile city Delhi z11 | 100k | 8.5 | 4 | 2.3 | 2.0 | 47.1 | 47.6 | 0 |
| tile city Dubai z10 | 100k | 38.8 | 35 | 48.3 | 0.1 | 46.9 | 52.9 | 0 |
| tile city Dubai z10 | 1M | 316.7 | 313 | 470.5 | 0.0 | 47.1 | 52.5 | 0 |
| tile city Dubai z10 | 5M | 1,626.1 | 1,621 | 2,435.7 | 0.0 | 47.4 | 52.0 | 0 |
| tile country z4 | 5M | 1,968.4 | 1,965 | 3,033.1 | 0.0 | 48.8 | 52.1 | 0 |
| fill ≤500 | 5M | 128.0 | 117 | 127.2 | 0.0 | 37.2 | 32.8 | 25.1 |
| legacy random 500 | 5M | 89.2 | 72 | 98.5 | 0.1 | 51.3 | 30.2 | 19.6 |
| quantile (created_at, country) | 5M | 1,649.0 | 1,646 | 2,901.2 | 0.0 | 52.9 | 47.1 | 0 |
| pills `by_project` | 5M | 2.7 | 1 | 0.2 | 24.1 | 9.1 | 46.8 | 0 |

Phase attribution inside the expensive queries (measured collector children):

- **Tile agg**: `GeoTileGridAggregator` is ~47–50% of shardCPU at every volume
  (e.g. 1,456 ms of 3,033 ms at 5M country); the filter/geo pass is the other
  ~49%; rewrite ≈ 0.
- **List (split)**: `SimpleFieldCollector` (indexed sort) 11.0 ms of 58.3 ms
  shardCPU at 5M; the filter pass (`ConstantScoreQuery`: term + range + geo)
  is 31.1 ms; fetch 1.6 ms (lean corpus understates real `_source` bytes).
- **Counters fallback** (`SPLIT_COUNTS=0 NATIVE_COUNTS=0`): three
  filter→`value_count` siblings cost 124.2 ms + 48.4 ms at 5M (178 ms total
  shardCPU vs 46–58 ms for the shipped paths) — the regression the strategy
  switch removed.
- **Exact count alternatives at 5M (wall / shardCPU)**: split count-only
  35.6 / 46.3; inline `tth:true`+terms on the list query 42.4 / 51.1;
  list+count split total 49.8 / ~104.6. Note the honest nuance: **inline
  native counting uses about half the total shard CPU of split list+count**
  on this corpus; split’s measured benefit is reuse (page/sort-invariant
  key), not single-request cost. Both beat the counter/capped fallbacks.
- **Fill**: fetch-dominated on lean corpora (25%); at 100k fill was 85.9%
  fetch (29 ms `took` for 500 lean docs) — representative of the unfiltered
  top-K fetch, not of production `_source` size.

### 5.2 Density effect (same shape, different viewport)

Tile cost scales with **matching docs**, not corpus size. Dubai z10 contains
93% of the corpus; Delhi z11 contains ~7% (properties only):

| Viewport | 100k | 1M | 5M | CPU per 1k in-frame docs |
| --- | --- | --- | --- | --- |
| Delhi z11 (7k→350k in frame) | 2.3 ms | 17.8 ms | 77.7 ms | ~0.22 ms |
| Dubai z10 (93k→4.65M) | 48.3 ms | 470.5 ms | 2,435.7 ms | ~0.52 ms |

The corpora deliberately stack all documents into the same footprints, so a
“city” viewport is really a 93%-match viewport. A production city viewport
(thousands of in-frame listings) maps to the low end of this table.

---

## 6. End-to-end action traces (measured)

### 6.1 Cold initial load — `Server-Timing` phases (ms, wall)

Phases overlap where parallel: `list` (list+count), `markers` (tile fan-out +
merge + fill), `fill` is inside `markers`.

| Corpus | rl | cache | ping | quantile | list | markers | fill | serialize | total HTTP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live | 2.2 | 16.6 | 53.6 | – | 89.7 | 211.9 | 12.7 | 2.1 | 268.5 |
| 100k | 2.6 | 9.6 | 94.9 | – | 296.4 | 508.1 | 118.9 | 5.9 | 611.7 |
| 1M | 1.5 | 7.0 | 36.6 | – | 290.5 | 419.1 | 97.7 | 6.1 | 462.4 |
| 5M | 1.5 | 5.3 | 31.3 | – | 304.6 | 688.2 | 251.9 | 9.0 | 729.1 |

Observations: markers dominate cold loads (tile fan-out + fill), 2–4× the list
phase; the first request after process start pays JIT/`ping` warmup (53–95 ms
included above); `rl` and cache reads are ≤10 ms.

### 6.2 Per-action cold/warm matrix (100k and 5M excerpts, full data in `bench-results/actions-*.json`)

| Action | Corpus | Cold total | Cold ES queries | Warm p50 / p95 / p99 | Warm payload |
| --- | --- | --- | --- | --- | --- |
| Initial load | live | 543 ms | 10 | 9 / 37 / 58 ms | 17 KB |
| Initial load | 100k | 976 ms¹ | 10 | 33 / 66 / 67 ms | 465 KB |
| Initial load | 1M | 537 ms | 10 | 25 / 57 / 60 ms | 391 KB |
| Initial load | 5M | 798 ms | 10 | 24 / 69 / 96 ms | 392 KB |
| Pan within tile set | 100k | 277 ms | 9 | 23 / 47 / 70 ms | 465 KB |
| Cross-tile pan | 100k | 53 ms | 8 | 7 / 13 / 15 ms | 164 B (empty) |
| Filter price | 100k | 27 ms | 0 (hit) | 19 / 28 / 51 ms | 465 KB |
| Filter BHK | 5M | 130 ms | 12 | 7 / 10 / 11 ms | 167 B |
| Sort beds | 5M | 1,049 ms | 8 | 33 / 66 / 75 ms | 403 KB |
| Country z4 | 5M | 1,669 ms | 14 | 19 / 40 / 58 ms | 352 KB |
| Load More p2 | 5M | 1,725 ms | 4 | 7 / 47 / 48 ms | 15 KB |
| Pills | 5M | 85 ms | 2 | 6 / 8 / 11 ms | 20 B |
| Marker click | 5M | 78 ms | 0 | 7 / 17 / 17 ms | 0.8 KB |
| Autocomplete | 5M | 651 ms² | 0–2 | 4 / 5 / 6 ms | 1.4 KB |

¹ First request on a just-started process includes JIT/connection warmup.
² Includes MapTiler geocoding; warm autocomplete is Redis-cached (30 s TTL).

Every warm action measured 100% full-hit (`list:HIT,markers:HIT`) with
`es/req = 0.00`; warm latencies track payload size and app serialization
(p50 5–33 ms), not ES.

### 6.3 Representative cold traces

**Initial load, 100k (611 ms total).** Rate limit 2.6 → Redis misses 9.6 →
`es.ping` 94.9 (first request only) → in parallel: list+count 296 ms, tile
fan-out (8 tile aggs, adaptive precision) + fill 119 ms → markers phase 508 ms
→ serialize 6 ms. ES backend: 10 shard queries. The two parallel branches
share the wall clock; `markers` ends up critical.

**Sort change to “beds”, 5M (1,031 ms).** list 299 ms + markers 1,016 ms
(parallel; fill 600 ms of it). Sorting by `bedrooms` with `missing:_last` and
`unmapped_type` visits every in-viewport match (350k) and the fill query pays
the same sort at size 500; the tile path narrows reps via the sort-aware
`top_hits`. This is the single most expensive *interactive* action measured.

**Load More page 2, 5M (1,712 ms).** No bounds on the append path (list mode)
→ list+count over the full 5M population (count reused from cache when the
population matches, but this is the global population). Deep pagination is
bounded by match volume; at production scale the client only enters list mode
without bounds, so this is the worst realistic case.

---

## 7. Load, throughput, and resources (measured)

All levels: 0% errors, 0 search rejections, distinct IPs. ES = 1 GB heap,
1 shard/index. `es/req` from shard `query_total` deltas.

### 7.1 Warm (full cache hit)

| Corpus | conc | QPS | p50 | p95 | p99 | ES cpu max | app cpu max | app RSS max | payload |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live | 25 | **484.4** | 42 | 116 | 133 | 11% | 62% | 117 MB | 17 KB |
| live | 50 | 474.7 | 52 | 177 | 183 | 10% | 42% | 131 MB | 17 KB |
| 100k | 10 | 81.4 | 112 | 172 | 198 | 15% | 152% | 191 MB | 465 KB |
| 100k | 50 | 58.8 | 725 | 899 | 1073 | 13% | 124% | 216 MB | 465 KB |
| 1M | 25 | 95.1 | 259 | 353 | 359 | 9% | 88% | 238 MB | 391 KB |
| 5M | 10 | 79.4 | 120 | 192 | 214 | 12% | 127% | 193 MB | 392 KB |
| 100k-s6 | 25 | 85.3 | 228 | 395 | 461 | 6% | 116% | 203 MB | 465 KB |

The warm ceiling is set by payload bytes and app JSON serialization: 17 KB →
~480 QPS; 391–465 KB → ~80–95 QPS. ES is idle (≤24%). This is invariant to
corpus size and shard count.

### 7.2 Cold (unique viewport per request)

| Corpus | conc | QPS | p50 | p95 | p99 | es/req | ES cpu max | queue max | app cpu max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| live | 1 | 27.8 | 30 | 74 | 164 | 9.94 | 33% | 0 | 36% |
| live | 25 | 151.9 | 155 | 295 | 341 | 6.70 | 50% | 0 | 97% |
| live | 50 | 147.2 | 288 | 445 | 481 | 6.43 | 50% | 2 | 77% |
| 100k | 10 | 62.5 | 145 | 305 | 360 | 7.38 | 45% | 1 | 78% |
| 100k | 25 | 73.0 | 243 | 481 | 555 | 6.62 | 53% | 0 | 90% |
| 100k | 50 | 95.7 | 341 | 778 | 844 | 6.36 | 53% | 0 | 84% |
| 1M | 10 | 42.3 | 172 | 548 | 680 | 7.38 | 63% | 2 | 56% |
| 1M | 50 | 50.8 | 634 | 1468 | 1636 | 6.36 | 73% | 93 | 86% |
| 5M | 10 | 23.7 | 256 | 870 | 1063 | 8.17 | 80% | 9 | 42% |
| 5M | 50 | 38.0 | 377 | 1247 | 1525 | 7.22 | 50% | 103 | 54% |

Cold throughput degrades ~3–4× from live to 5M (147 → 38 QPS at conc 50)
while `es/req` stays bounded (6.4–8.2). The pipeline is ES-queue-bound at 5M:
queue peaks of 93–183 with 0 rejections and ≤82% CPU; per-query latency grows
with match volume, not with request count.

Cross-tile cold at 5M (city pans with fresh unions): 7.6–36 QPS, p99 up to
2.1 s, ES CPU 62–82%, queue ≤183 — the same picture, concentrated in dense
viewports.

### 7.3 Redis (one measured sample, 100k warm conc 25)

253 ops/s during load; keyspace 193 hits / 101 misses (65.7% Redis-level hit
ratio across all lookups including misses on the second key); `X-Cache`
full-hit rate for the level: 84% (the run included a flush; steady warm is
100%). Note per request there are 1 rate-limit call + 2 `cacheGet`s + lock
checks (and, on misses, singleflight lock/waits), so Redis op counts exceed
request counts.

---

## 8. Scale analysis

### 8.1 Measured scaling curves (single node, 1 GB heap, 1 shard)

| Operation | 1.5k | 100k | 1M | 5M | scaling |
| --- | --- | --- | --- | --- | --- |
| Cold list+count wall (city) | 90 ms¹ | 296 ms² | 291 ms² | 305 ms² | flat once page ≤24; dominated by first-request effects at live |
| Cold list query CPU (city) | 2.6 ms | 4.9 ms | 12.4 ms | 58.3 ms | ~linear in in-frame matches |
| Count CPU (city) | 0.5 ms | 2.0 ms | 9.9 ms | 46.3 ms | ~linear |
| Tile agg CPU (city, dense) | 1.5 ms | 48.3 ms | 470.5 ms | 2,435.7 ms | ~linear in matches (~0.5 ms/1k) |
| Tile agg CPU (country) | 1.5 ms | 66.9 ms | 594.6 ms | 3,033.1 ms | ~linear (~0.6 ms/1k) |
| Quantile CPU (country) | 1.9 ms | 66.4 ms | 562.5 ms | 2,901.2 ms | ~linear; 24 h cache |
| Fill wall (500) | 6.1 ms | 45.7 ms | 55.8 ms | 128.0 ms | sub-linear-ish (top-K) |
| Legacy random 500 wall | 6.6 ms | 40.6 ms | 39.8 ms | 89.2 ms | ~flat (fetch-bound at 500 docs) |
| Pills | 4.2 ms | 6.9 ms | 2.6 ms | 2.7 ms | unrepresentative (no indexed `project_name`) |

¹ live initial-load phases, not a like-for-like viewport; ² `list` Server-Timing
phase = list+count parallel.

**The architectural bound holds**: per-request ES work (`es/req`) does not grow
with corpus size — 6.4–9.9 cold at every volume. What grows is the cost of
each query because aggregations/counts/sorts visit matching documents.
Linear extrapolation (**extrapolated**) to 10M: country tile agg ≈ 6 s CPU,
national count ≈ 90 ms, national list ≈ 100 ms; city viewports with realistic
in-frame counts (~10k–50k) remain in the 5–30 ms CPU range.

### 8.2 Sharding effect (measured, 100k 1-shard vs 6-shard)

| Scenario | 1 shard | 6 shards | Delta |
| --- | --- | --- | --- |
| list both/newest wall | 14.4 ms (2 shards) | 18.3 ms (12 shards) | +27% wall, query CPU 4.9→15.3 ms |
| tile Dubai z10 wall | 38.8 ms | 21.0 ms | **−46% latency** (parallel shards), CPU 48.3→60.7 ms |
| count both wall | 7.3 ms | 9.1 ms | +25% |
| cold unique `es/req` | 6.4 | **35.2–50.4** | 5.5–7.9× backend work |
| cold unique QPS conc 10 | 62.5 | 26.3 | −58% |
| cold unique QPS conc 50 | 95.7 | 77.0 | −20% |
| per-shard query distribution | trivial | 13/13/13… every shape | even (key-hashed, jittered docs) |

Resharding parallelizes a single query (Dubai agg halved) but multiplies
fan-out on one node and lowers throughput at realistic concurrency. **Nodes
buy throughput only after fan-out is batched and `GEO_ROUTING` is fixed**
(code-verified: routing params are sent on tile/fill searches but docs are not
indexed with routing; on multi-shard indices this silently prunes matches).

### 8.3 Corpus/production representativeness (limitations)

- Lean mapping omits stored-only preview fields → fetch phase is
  understated at 100k/1M/5M (live 1.5k shows fetch at 77% of list CPU).
- All docs concentrate in two metro footprints → “city” viewports are
  high-match viewports; use the per-1k-in-frame column.
- Single node, no replicas, shared host; absolute QPS are floors and ranks are
  the transferable result.
- No CDN in this environment: edge behavior is verified by headers/canonical
  URLs (`scale:e2e`), not by observed edge hit rate.

---

## 9. Parity and correctness (measured)

| Check | Result |
| --- | --- |
| `npx jest --ci` | **17 suites / 141 tests PASS** (incl. count-strategy shape pins) |
| `npm run scale:smoke` | **all PASS** (caps, fan-out 99→35, flags, routing helpers) |
| `npm run scale:e2e -- --base=:3200` | **50/50 PASS** (scope isolation, fetch-free markers, edge canonicalization, index invariants) |
| Split vs inline counts, 12 scenarios (100k) | totals/relation identical, result and marker IDs identical, 12/12 PASS |
| Ground truth (direct ES count) | never greater than served count in any scenario (widen-only holds; no narrowing) |
| Live-server regression after instrumentation | e2e 50/50 with `ROUTE_TIMING=1` on |

---

## 10. Bottlenecks and prioritization

### 10.1 Ranked bottlenecks (measured)

1. **Dense-viewport tile aggregation is O(matches)** — 2.4–3.0 s shardCPU at
   5M for Dubai z10/country z4; the country overview first-load measured
   1.67 s wall (`quantile` 55 ms + `list` 1.2 s + `markers` 1.6 s, parallel).
2. **Warm payload bytes cap app throughput** — 465 KB responses hold one
   instance to ~81–95 QPS vs ~480 QPS at 17 KB; ES is idle.
3. **Cold p99 under concurrency** — 1.5–1.6 s at 1M/5M conc 50, driven by ES
   search-queue depth (93–183 observed) from unbatched tile fan-out.
4. **First cold overview request per region×field×intent pays quantile
   compute synchronously** — measured 1.65 s wall / 2.9 s CPU at 5M
   (TDigest over 3.5M matches), then cached 24 h.
5. **Cold list+count CPU doubles under split counts** vs inline native
   (5M: ~104.6 vs 51.1 ms shardCPU), though page-1 wall is within noise and
   count reuse across pages/sorts is the offsetting benefit.
6. **Shard fan-out amplification (measured 5.5–7.9×)** — blocks horizontal
   scaling until batched; `GEO_ROUTING` is a correctness prerequisite.
7. **Host capacity, not architecture** — 2 GB heap + shared Supabase stack on
   a 3.8 GiB VM wedged ES during bulk indexing; 1 GB heap is stable but limits
   per-query parallelism.

### 10.2 Recommended actions (each tied to a measurement)

| # | Action | Measured basis | Expected effect | Effort/risk |
| --- | --- | --- | --- | --- |
| 1 | **Precompute/background-refresh quantiles** (cron already exists) and never await on the request path | 1.65 s wall once per region×field×intent at 5M | Removes first-overview stall; p99 at country zoom improves by up to ~1.6 s (measured cost removed) | Low (flag/reuse cron) |
| 2 | **Batch tile fan-out (+ list + count) into `_msearch`** (`MSEARCH_ENABLED` exists, unused) | queue 183 at 5M conc 50; 8–12 shard queries per cold request | Lower p99 under load by collapsing ~10 RTTs to 1; expected, not yet implemented | Medium; parity harness exists |
| 3 | **Trim warm marker payload** (or gzip/br at edge; validate fetch-free contract) | 17 KB → 480 QPS vs 465 KB → 81 QPS | Roughly proportionate warm-capacity gain per byte removed (app-bound); CDN removes origin cost entirely | Medium; Invariant 3 must hold |
| 4 | **Edge/CDN rollout** (headers and canonical URLs already verified) | warm path 0 ES, 6–33 ms p50 origin | The only measured path to millions of warm users without adding origin capacity | Ops only |
| 5 | **Overview-zoom aggregation policy**: coarser precision and/or count-only cells above a match threshold, or precomputed rollup for z<6 | country z4: 0.6 ms CPU/1k docs → 3 s at 5M | Bounds the worst viewport; requires UX iteration (cell counts instead of pins at national zoom) | Medium; product input needed |
| 6 | **Gate `GEO_ROUTING` off (or index with routing) before reshaping** | code-verified latent multi-shard match loss | Correctness prerequisite; no perf effect at 1 shard | Low |
| 7 | **Set `TILE_SHADOW=0`** | ~1% of tile-served computes fire an extra legacy 500-doc query; Invariant 1 tension | Small QPS/CPU win; removes sampling from warm traffic | Trivial |
| 8 | **Keep split counts but measure the page-1 tradeoff**; consider `_msearch` list+count to make the parallel branch cost one RTT | 5M: inline 42.4 ms vs split list 49.8 ms (parallel count 35.6 ms); reuse across pages/sorts is the split win | Recovers ~7 ms page-1 wall, keeps page/sort reuse; do not revert blindly — the counter fallback is 2–4× worse | Low |
| 9 | **Rate limiter: call once per GET and after the cache lookup** | code-verified double charge on GET; measured `rl` 0.5–2.6 ms and 1–2 Redis ops/request | Minor latency/op reduction on every warm request | Low |
| 10 | **Capacity**: add nodes only after 2 and 4; then reshare with `ES_SHARDS` and assign replicas | 6-shard test: 5.5–7.9× fan-out, lower low-conc QPS; shard variants even | Nodes buy throughput, not latency (prior-measured + this run) | Ops |

Not recommended: capping/approximating counts (counter fallback measured
2–4× slower; capped counting saves no time), or narrowing caches (AD5/AD6).

---

## 11. Reproduce

```bash
# 0. Production build + benchmark server (defaults unchanged)
npm run build
PORT=3200 ROUTE_TIMING=1 npm run start

# 1. Gates
npx jest --ci                        # 141 tests
npm run scale:smoke
npx tsx scripts/scale-e2e.ts --base=http://localhost:3200

# 2. Corpora (deterministic; requires ES with ~2 GB free disk per 5M)
node scripts/build-scale-corpora.mjs 100000  --suffix=_100k
node scripts/build-scale-corpora.mjs 1000000 --suffix=_1m
node scripts/build-scale-corpora.mjs 5000000 --suffix=_5m
node scripts/make-shard-variant.mjs bench_tile_100k bench_tile_100k_s6 6

# 3. Corpus instance + measurements
PORT=3210 ROUTE_TIMING=1 ES_PROPERTIES_INDEX=bench_props_100k \
  ES_PROJECTS_INDEX=bench_projects_100k ES_TILES_INDEX=bench_tile_100k npm run start
node scripts/flush-app-cache.mjs
ES_PROPERTIES_INDEX=bench_props_100k ES_PROJECTS_INDEX=bench_projects_100k \
  ES_TILES_INDEX=bench_tile_100k npx tsx scripts/profile-browse-queries.ts --label=100k --runs=11
npx tsx scripts/bench-browse-actions.ts actions --base=http://localhost:3210 --label=100k --n=30
for sc in warm subtile crosstile unique; do
  npx tsx scripts/bench-browse-actions.ts load --base=http://localhost:3210 --label=100k \
    --scenario=$sc --conc=1,10,25,50 --n=100
done

# 4. Count parity (split vs inline)
PORT=3220 SPLIT_COUNTS=0 ES_PROPERTIES_INDEX=bench_props_100k \
  ES_PROJECTS_INDEX=bench_projects_100k ES_TILES_INDEX=bench_tile_100k npm run start
ES_PROPERTIES_INDEX=bench_props_100k npx tsx scripts/verify-count-parity.ts \
  --a=http://localhost:3210 --b=http://localhost:3220 --flush=true
```

Raw artifacts: `bench-results/profile-*.json|log`, `actions-*.json`,
`load-*.json`, `DIGEST.txt`, `profile-tables.txt`, `baseline-dirty.diff`.

## 12. Limitations

- Single ES node (1 GB heap, Docker VM 3.8 GiB shared with Supabase), 1 shard
  unless stated, replicas unassigned; absolute latencies/QPS are host-bound
  floors; rankings are the transferable result.
- Lean corpora omit stored-only preview fields (fetch phase understated) and
  index `project_name` is absent (pills unrepresentative); text/autocomplete
  at scale not profiled.
- Concentrated geography makes “city” viewports high-match; use per-1k
  in-frame normalization.
- 5M profile runs used 7 iterations (vs 11) and show higher variance.
- Load generators share the host with the app; warm QPS at high concurrency
  reflects generator CPU contention as well as app capacity.
- No CDN present: edge caching is verified structurally, not by hit rate.
- Multi-node behavior remains theoretical; the 2-node attempt in the prior
  report destabilized the host.
