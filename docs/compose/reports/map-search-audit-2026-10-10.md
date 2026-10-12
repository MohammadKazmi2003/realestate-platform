# Map Search / Browse Architecture — Audit & Benchmarks

- **Date**: 2026-10-10
- **Revision**: `8f93db0` (clean tree; second pass committed during this session)
- **Baseline revision for A/B**: `5c11e3a` (built from a git worktree)
- **Method**: static read of the hot path + production-build benchmarks + live ES `profile:true` probes + 100k-doc scratch corpus. Every number is labeled **measured**, **prior-measured** (from `map-hotpath-efficiency-audit.md`), **extrapolated**, or **unknown**.

---

## 1. Environment and measurement conditions

| Item | Value |
| --- | --- |
| App | Next.js 15.5.25, production build (`npm run build && npm run start`), single instance unless stated |
| ES | 8.15.0, single node, 1 shard per index, replicas unassigned (yellow), 512 MB heap (used 292 MB) |
| Redis | 7 (Docker), local |
| Dataset | 1,543 docs: 108 properties (India) + 1,435 projects (Dubai); `listings_tile` 965 KB |
| Scratch corpus | `bench_tile` 100,295 docs / 20.7 MB (65 jittered copies of `listings_tile`) |
| Host | macOS, 8 cores, 8 GB RAM, load avg 4–6 (other apps active); rate limiter uses distinct `x-forwarded-for` per request |

Two methodological notes that affect how numbers read:

1. **The server that was running at session start was `next dev --turbopack`.** All HTTP numbers in this report were re-run against a production build. Dev-mode numbers were discarded (they showed ~260 ms fixed per-request overhead and ~18 QPS route ceilings).
2. **`_nodes/stats` `query_total` counts shard-level queries, not HTTP searches** (verified: a 2-index search over two 1-shard indices increments by 2). "ES/req" below is backend shard-queries per HTTP request. Round trips are called out separately where it matters.

---

## 2. What changed, and why it reduces work

Current request path (`POST`/`GET /api/map-data`), with the second-pass deltas marked **[new]**:

1. **Rate limit** (Redis sliding window) → **clamp + canonical tile-union bounds** (`viewportCoveringTiles` → `coveringTileUnionBounds`).
2. **[new] Keys are the covering-tile union** (`md:v5:l|m:…`, 64-bit FNV) — any pan resolving to the same z/x/y set shares list, markers, tiles, and pills. Superset of the viewport (AD5), so a hit can never hide a listing.
3. **Two Redis GETs** (list + markers). Full hit → response, **0 ES**, no health ping.
4. Cold: **list query** (`size:24`, indexed sort + `id` tiebreaker, `track_total_hits:false`, badge counts from filter→`value_count` siblings) and **marker tile fan-out** in parallel, both coalesced by `singleflightCompute` (in-process L1 + Redis SET NX L2).
5. Marker path: ≤8 covering tiles → `geotile_grid` + `top_hits:1` per cell against the unified `listings_tile` index (1 search/tile, no scoring, no total hits), adaptive precision ≤2 attempts, **stop on 0 cells** [new], then merge/dedupe/clip/stride to ≤500. Fill query only when the population is clustered and >500; **[new] skipped entirely when cells are unclustered** (reps are exact).
6. `GET /api/map-data` **[new]** forwards the common filter set (polygons/cursor rejected 400), sets `s-maxage` by sort tier and a normalized `Vary`, so a stock CDN can absorb warm traffic.
7. Expensive rollups are off-path: `by_project` pills on `/api/project-groups` (union key, 300 s+ TTL, coalesced) [new key/coalescing], quantiles on a 24 h per-region cache.
8. Index weight: `listings_tile` (14 indexed fields, preview fields stored-only, no analyzers); dead `*.autocomplete`/`*.keyword` subfields and `properties.suggest` removed **[new]**; index/search analyzers split (synonyms off the write path) **[new]**; template-application defect fixed **[new]**.

Eliminated from the served path: `function_score/random_score`, 500-doc marker fetch, exact `track_total_hits`, per-tile `p90` percentiles, inline `by_project`, split-index tile queries for `scope=both`, and precision refinement on empty tiles.

---

## 3. Correctness verification (production build)

| Check | Result |
| --- | --- |
| `npm run test:ci` | **16 suites / 132 tests PASS** |
| `npm run scale:smoke` | **all PASS** (caps, fan-out 99→35, flags, routing) |
| `npm run scale:e2e` | **50/50 PASS** — scope isolation (`scope=properties` returns only properties), fetch-free markers (29 fields), pagination cursor present, pill cache HIT, edge canonicalization, body byte-identical across RSC headers, `s-maxage`, no `Set-Cookie`, index weight invariants |
| Tile vs legacy marker parity (same build, cache flushed, identical viewports) | **identical marker sets**: 86 markers over 6 viewports on both paths; dense Dubai 500 on both |
| Warm pan sync | 20/20 `list:HIT,markers:HIT`; sub-tile pans 19/20 HIT |

Finding (minor, code-verified + measured): **empty viewports are cached on `/api/map-data`** (ocean tile: first call MISS, second `X-Cache: HIT` with `markers:0`) whereas `/api/map-tiles` deliberately refuses to cache empty payloads. Not a correctness break, but the two routes disagree on Invariant-4 behavior.

---

## 4. Measured results

### 4.1 Layer ceilings (`scale:layered`, prod, conc 10/25/50, n=200)

| Layer | Ceiling | p99 | Notes |
| --- | --- | --- | --- |
| Redis GET | ~33,300 QPS | 2 ms | never the constraint |
| ES tile-agg (direct, same shape as app) | **~1,770 QPS** | 49 ms | `queue=0 active=0/13 rejected=0` throughout |
| `GET /api/map-tiles` (warm) | ~389 QPS | 204 ms | es/req 0 (dead route, see §6) |
| `POST /api/map-data` (warm) | **~325 QPS** | 222 ms | es/req 0 |
| Route/ES ratio | 0.22 | — | **app-layer bound; ES has headroom** |

### 4.2 Cold path (`scale:cold`, unique viewport per request, n=150)

| Case | QPS | p50 | p99 | ES/req | err |
| --- | --- | --- | --- | --- | --- |
| `map-data` both z~11 | 156–193 | 61–233 ms | 93–471 ms | **6.72–7.13** | 0% |
| `tiles GET` both z~11 | 278–412 | 34–119 ms | 60–342 ms | 1.09–1.14 | 0% |
| `tiles GET` props z~11 | 161–344 | 52–128 ms | 106–294 ms | 1.08–1.29 | 0% |
| `tiles GET` both z~8 | 253–373 | 37–107 ms | 125–249 ms | 0.79–1.30 | 0% |

Aggregate ES demand at these levels ≈ 6,607 shard-queries/s. Worst observed fan-out 7.13 shard-queries/request (list 2 + tiles + fill).

### 4.3 Browse matrix (prod)

| Scenario | p50 | ES/req | Cache | Notes |
| --- | --- | --- | --- | --- |
| Warm repeat (Delhi z11) | **8 ms** | **0.00** | 20/20 HIT | 49,733 B payload |
| Sub-tile pans (same tile set) | 6 ms | 0.60 | 19/20 HIT | 1 union-boundary miss |
| Cross-tile pans (unique unions) | 19 ms | 8.20 | 10/10 MISS | empty regions → 0 markers |
| Warm after cross-tile | 7 ms | 0.00 | 10/10 HIT | |
| Filters (price/type/BHK/intent/amenities/scope/sort) | cold 6–51 ms, warm **3–7 ms** | cold 6–8, warm **0.00** | warm 100% HIT | 11 combinations |
| Dense Dubai z10 | warm 22 ms (cold 76 ms) | 0.00 | HIT | 500 markers, 510,607 B |
| India-wide z5 | 12 ms | 2.00 | 4/5 HIT | 108 markers, 123,724 B |
| Sidebar page 2 (`map-data` cursor and `/api/search`) | 15 ms | 2.00 | uncached by design | viewport exhausted → 0 results; 2nd query is the empty-state count |

### 4.4 Cache-key A/B — current vs `5c11e3a` (same dataset, cache flushed, identical viewports)

| Test | Current `8f93db0` | `5c11e3a` (exact-bounds keys) |
| --- | --- | --- |
| 12 sub-tile pans (≤0.012° drift) | **ES/req 0.42, 11/12 HIT, p50 8 ms** | **ES/req 4.00, 0/12 HIT, p50 14 ms** |
| 6 cold unique viewports | 5.00 shard-q/req, 86 markers | 4.33 shard-q/req, 31 markers (viewport-clipped) |
| Warm Dubai z10 | 0 ES, 500 markers | 0 ES, 500 markers |

This is the headline change: panning inside one tile set went from a guaranteed cache miss (4 backend shard-queries per pan) to ~0.4 (one boundary miss in 12).

### 4.5 Flag A/B — tile grid vs legacy `random_score` (same build)

| | tile path | legacy (`MAP_TILES_V1=0 TILE_INDEX_V1=0`) |
| --- | --- | --- |
| Cold unique x6 | 5.00 shard-q/req | 3.33 shard-q/req (2 HTTP searches: list + marker) |
| Markers | 86 | 86 (identical) |
| Warm | 0 ES | 0 ES |

Legacy uses fewer round trips; each tile query is much cheaper (§4.7). The trade is bounded per-query cost vs round-trip count — and round trips are the item `MSEARCH_ENABLED` was meant to batch (§6).

### 4.6 Horizontal scaling (warm, prod, one generator process per instance)

| | Aggregate QPS | p50 | p99 | ES/req |
| --- | --- | --- | --- | --- |
| 1 instance (2×25 conc) | 355.2 | ~140 ms | 190–637 ms | 0.00 |
| 2 instances (2×50 conc) | **510.7 (+44%)** | 171–193 ms | 302–932 ms | 0.00 |

ES pool idle during both. Caveat: contended 8-core host with a shared Redis and a single generator process per instance; prior measurement on an idle host with 4 generators reported +61% (prior-measured). Direction is consistent; absolute scaling factor is host-bound, not architecture-bound.

### 4.7 ES profile — per-query costs at 1.5k and 100k (medians of 11, `profile:true`)

Profile query/collector times are **per-shard CPU durations and overlap** (`took` is wall); do not sum them. `took` includes fetch/merge/network phases.

| Query shape | 1.5k docs | 100k docs |
| --- | --- | --- |
| Legacy `random_score` 500, all matches | 63 ms (FunctionScore 1.6 + collector 1.4) | **61 ms** (FunctionScore 44.3 + collector 31.2) |
| Legacy `random_score` 500, Delhi box | — | **29 ms** (FunctionScore 4.2 + collector 1.6) |
| Sort `created_at+id` 500 | 55 ms | 54 ms (all) / 28 ms (Delhi) |
| Filter-only 500-doc fetch | 39 ms | 9 ms |
| **Tile agg** (`geotile_grid`+`top_hits`) | 4 ms | **58 ms all / 5 ms Delhi** |
| List 24, no aggs | 5 ms | 30 ms |
| List 24, `track_total_hits=true` (exact) | 4 ms | **27 ms** |
| List 24 + `by_entity_type` terms (legacy badge) | 5 ms | **40 ms** |
| List 24 + `by_entity_type` + `by_project` | 4 ms | 43 ms |
| **List 24 + 3 `value_count` counters (current)** | 7 ms | **84 ms** |
| List 24 + 2 counters (drop `exact_total`) | — | 61 ms |
| Percentiles `created_at` (quantile cache) | 2 ms | 49 ms |
| `by_project` terms (pills) | 1 ms | n/a (dataset names empty) |

Interpretation (measured, not estimated):

- **Marker path at a city viewport, 100k docs: 5 ms vs 29 ms** for the legacy random-score path (5.8×). The legacy cost is dominated by the score-all pass + 500-doc fetch; the tile agg visits the same docs but returns one rep per cell with no scoring and no cross-cell sort.
- **The exact-counter badge design is a scale regression.** At 100k, 3 counters cost 84 ms vs 27 ms for exact `track_total_hits=true` and 40 ms for the legacy `tth=true + by_entity_type` path — which returns the same badge data (exact total + per-entity split). Each counter runs a full additional match pass (~25–27 ms each at 100k); `exact_total` alone is ~23 ms and is redundant (property + project sum). The code comment claiming "+2–5%" is not supported by measurement.
- **Country-wide tile aggs are O(matches)** (58 ms at 100k for the all-India+Dubai box) — viewport-bounded, and the low-zoom UX uses cells rather than 500 pins. City-scale viewports are 5 ms.
- **`random_score` scoring is not the dominant legacy cost at small scale** (1.6 ms of 63 ms) but becomes visible at 100k (44 ms of 61 ms). No in-repo profiling artifact supports the historical ">60% of query work" figure; the measured decomposition attributes legacy marker cost to scoring + 500-doc fetch combined, both of which the tile path removes.

### 4.8 Index weight (measured)

| Index | Docs | Store | Notes |
| --- | --- | --- | --- |
| `properties_v1` | 108 | 142 KB | dead subfields removed, analyzers split |
| `projects_v1` | 1,435 | 5.8 MB | keeps `suggest` (autocomplete) |
| `listings_tile` | 1,543 | 965 KB | ~16% of primaries; 14 indexed fields, rest stored-only |
| `bench_tile` (scratch) | 100,295 | 20.7 MB | ~0.21 KB/doc |

---

## 5. Benchmark summary table

| Metric | Baseline | Current | Change | Conditions |
| --- | --- | --- | --- | --- |
| Sub-tile pan backend queries | 4.00 shard-q/req (`5c11e3a`) | **0.42** | **−89%** | prod, cache flushed, 12 pans |
| Sub-tile pan cache hits | 0/12 (`5c11e3a`) | **11/12** | — | same |
| Warm map-data backend queries | 2 (pre-tile, prior-measured) | **0.00** | −100% | prod, repeat viewport |
| Cold map-data backend queries | 10.78 (prior-measured) | **6.72–7.13** | −34% | prod, unique viewport |
| Cold map-data QPS | — | 156–193 | — | prod, conc 10–50 |
| Warm route ceiling | ~360–375 QPS (prior-measured) | **~325 QPS** | within noise | prod, conc 10–50; host contended |
| ES tile-agg ceiling | 699→1,212 QPS (prior-measured) | **~1,770 QPS** | — | prod, direct ES probe |
| Marker query at 100k, city viewport | 29 ms (`random_score`) | **5 ms** (tile agg) | **−83%** | live ES profile, medians |
| Badge counting at 100k | 40 ms (`tth=true`+terms) | **84 ms** (counters) | **+110% (regression)** | live ES profile, medians |
| Warm QPS, 2 instances | 355 (1 inst) | **511** | **+44%** | contended host, 2 generators |
| ES saturation during load | `queue=17, active=13/13` (prior-measured) | **`queue=0, rejected=0`, cpu 4–22%** | — | sampled during load |
| `listings_tile` footprint | 6.4 MB primaries | **965 KB (16%)** | — | measured |

---

## 6. Remaining bottlenecks (code-verified, with evidence)

1. **Exact counters (measured regression at scale).** 84 ms vs 40 ms at 100k with identical badge data. `exact_total` is redundant. Fix: `track_total_hits: true` + `by_entity_type` terms on the list/search routes (keep lazy `by_project` off-path).
2. **Shadow mode samples a legacy marker query on warm traffic.** `TILE_SHADOW` defaults ON, `TILE_SHADOW_PCT=1`; the tile-served path fires `queryESMapMarkers` (500-doc `random_score`) for ~1% of warm requests, log-only (`map-data/route.ts`). Tension with Invariant 1.
3. **Tile fan-out is unbatched.** `MSEARCH_ENABLED` is declared but unused; cold requests issue up to 8 tile searches as parallel round trips instead of one `_msearch`.
4. **Cold-path adaptive refinement doubles sparse-tile queries.** Observed per-request shard-queries `[8,0,7,6,5,4]`; sparse (<150 cells) tiles refine once more (capped at 2 attempts).
5. **Quantile compute is awaited on the cold path** before list/markers start; 49 ms for a country-scale percentile at 100k, cached 24 h and coalesced — but serial on first touch of a region×field×intent at z<10.
6. **Empty viewports are cached on `/api/map-data`** (measured HIT on second call with `markers:0`), while `/api/map-tiles` refuses; inconsistent Invariant-4 handling.
7. **`/api/map-tiles` is dead code** (no caller in `src/`), still benchmarked at 389 QPS and maintained.
8. **App-layer bound, not ES.** Route/ES ratio 0.22; warm requests still pay rate-limit + 2–4 Redis round trips and Next serialization. The 512 MB-heap single-node ES is not the constraint at current traffic.
9. **Sidebar page 2 costs 2 shard-queries even when empty** (list + empty-state count).

---

## 7. Scalability assessment

**Established by measurement:**
- Warm traffic is absorbed with **0 ES queries** at ~8 ms p50; the cache layer (Redis 33k QPS ceiling) and CDN headers are the absorbing layers. The only per-request ES contact on a fully warm path is the 10 s health ping.
- Cold traffic is **bounded per request** (≤8 tiles × ≤2 attempts + fill + list ≈ 7 shard-queries typical) and ES showed **zero queue/rejection** at every load level tested; the app layer saturates before ES (ratio 0.22).
- Horizontal scale-out works in the measured direction (+44% warm QPS with 2 instances, 0 ES), but the test host (8 cores, load 4–6, shared Redis) caps the factor; prior idle-host measurement was +61% (prior-measured).
- Index growth is modest: ~0.21 KB/doc for the tile projection (10M ≈ ~2 GB) vs the primary indices; the tile index removes analyzers from the map path entirely.

**Not proven (unknowns):**
- **Millions of listings.** The largest corpus measured here is 100,295 docs (65×). Country-wide tile aggs and badge counters scale linearly in the viewport match count; the measured 100k costs (58 ms and 84 ms) extrapolate to ~100× at 10M, which is **extrapolation, not measurement**. A representative benchmark (≥1M docs, realistic shards/replicas, prod heap) is required before sizing ES.
- **Millions of concurrent users.** Only 2 app instances / ~511 QPS aggregate were tested; the CDN was asserted via headers and canonical URLs, not observed (no CDN in this environment).
- Per-request cost of rate limiting, Redis GETs, and Next serialization at very high concurrency (app-bound today; may shift with more instances).
- Pill/quantile cost with real `project_name` values and large regions (dataset has empty project names; pills measured at 1 ms and are therefore unrepresentative).

---

## 8. Prioritized next steps (each supported by a measurement or code fact)

1. **Revert badge counting to `track_total_hits: true` + `by_entity_type` terms** (or at minimum drop `exact_total`). Measured: 84 → 40 ms (−52%) at 100k, identical badge semantics; flip `EXACT_COUNT_COUNTERS` default and re-run §4.7. This also removes two full match passes per cold list query. **RESOLVED 2026-10-10** — shipped as `NATIVE_COUNTS` (default on): 218 → 83 ms at 1M all-matches (−62%), counts identical across 19 scenarios; see `es-count-strategy-2026-10-10.md`.
2. **Default shadow off** (`TILE_SHADOW=0`) or derive overlap from the tile payload; removes a sampled 500-doc legacy query from warm traffic.
3. **Implement `_msearch` for the tile fan-out** (flag already exists). Cold requests currently pay up to 8 round trips; batching them to 1 bounds p99 under load without changing results.
4. **Move quantile compute off the critical path** (background refresh / prewarm) so the first cold request for a region never waits on a 49 ms (100k) TDigest.
5. **Empty-viewport caching parity** between `/api/map-data` and `/api/map-tiles`; pick one policy and assert it in `scale:e2e`.
6. **Remove or wire `/api/map-tiles`** (dead route) to cut duplicated maintenance.
7. **Run a representative-scale benchmark** (≥1M docs, ≥3 shards, replicas assigned, prod heap) on the same harnesses before capacity sizing; the 100k corpus here is a slope indicator only.
8. **Add a sampled `profile:true` capture to the harness** so future per-clause claims remain reproducible (the probes in this report were run ad hoc; the shapes are documented in §9).

---

## 9. Reproduce

```bash
# 0. Production build (the dev server distorts all capacity figures)
npm run build && npm run start

# 1. Correctness gates
npm run test:ci                      # 16 suites / 132 tests
npm run scale:smoke                  # invariants, no services
npm run scale:e2e -- --base=http://localhost:3000   # 50 checks; clears md:v5/pg:v2 keys

# 2. Layer ceilings and cold path
npm run scale:layered -- --base=http://localhost:3000 --conc=10,25,50 --n=200
npm run scale:cold   -- --base=http://localhost:3000 --conc=10,25,50 --n=150

# 3. A/B against the previous revision (exact-bounds keys)
git worktree add ../head-5c11e3a 5c11e3a
ln -s "$PWD/node_modules" ../head-5c11e3a/node_modules && ln -s "$PWD/.env" ../head-5c11e3a/.env
(cd ../head-5c11e3a && npm run build && PORT=3102 npm run start)
# then: prime + jitter pans against :3000 (GET) and :3102 (POST) with md:v4/v5 flushed between runs

# 4. Flag A/B on one build
MAP_TILES_V1=0 TILE_INDEX_V1=0 TILE_SHADOW=0 PORT=3101 npm run start

# 5. 100k scratch corpus + per-query profile
#    (copy listings_tile 65× with jittered coords into bench_tile; see the build script in
#     this report's methodology: 1,543 source docs → 100,295 docs, 20.7 MB)
curl -s localhost:9200/bench_tile/_search -H 'content-type: application/json' -d '{
  "size":0,"track_total_hits":false,
  "query":{"bool":{"filter":[{"term":{"status":"available"}},
    {"geo_bounding_box":{"location":{"top_left":{"lat":35,"lon":54},"bottom_right":{"lat":8,"lon":97}}}}]}},
  "aggs":{"tiles":{"geotile_grid":{"field":"location","precision":5,"size":1000,"shard_size":1500,
    "bounds":{"top_left":{"lat":35,"lon":54},"bottom_right":{"lat":8,"lon":97}}},
    "aggs":{"top":{"top_hits":{"size":1,"sort":[{"created_at":{"order":"desc"}},{"id":{"order":"asc"}}]}}}}}},
  "profile":true}'
```

Methodology rules applied: production build; distinct `x-forwarded-for` per request; backend query counts from `_nodes/stats` deltas; thread-pool/queue sampled during load; `request_cache` sent as a URL parameter only in raw REST probes; cache cleared or keys varied before every "cold" measurement.

## 10. Limitations

- 1,543-doc production corpus and a 100,295-doc scratch corpus — request-path characterization, not match-volume capacity proof.
- Single ES node, 512 MB heap, 1 shard/index, replicas unassigned; not representative of a production cluster.
- Host was contended (load 4–6) during HTTP benchmarks; absolute QPS is a floor, not a ceiling.
- No CDN in front of this environment; edge behavior is asserted from headers/keys, not observed hit rate.
- Dubai holds projects and India holds properties, so `scope=both` rarely mixes entity types in one viewport (e2e asserts scope correctness directly).
- Pills aggregation is unrepresentative (dataset `project_name` is empty).
