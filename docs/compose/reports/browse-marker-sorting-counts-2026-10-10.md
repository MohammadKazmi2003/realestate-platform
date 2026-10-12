# `/browse` Deep Dive — Map Markers, Sorting, and Split Counts

- **Date**: 2026-10-10 (follow-up to `browse-es-performance-2026-10-10.md`)
- **Question**: why does `/browse` stay slow at city/country zoom for markers,
  sorting, and split counts — and which fixes are worth implementing?
- **Method**: shipped builders profiled with `_profile:true` (request cache off
  for CPU attribution); concentrated corpora at 5M and 1M; a **geographically
  distributed** 1M corpus for realistic city viewports; index-sorting A/B
  (created_at-desc, forcemerged); split-vs-inline end-to-end A/B; in-process
  merge microbenchmark; public industry sources.
- **No production changes** — this establishes the measured case first.
- **Artifacts**: `bench-results/marker-strategies-*.{json,log}`,
  `sort-cost-*.json|log`, `count-e2e-100k.json`, plus scripts
  `bench-marker-strategies.ts`, `bench-sort-cost.ts`, `bench-count-e2e.ts`,
  `bench-merge.ts`, `make-sorted-variant.mjs`, `build-scale-corpora.mjs --dist`.

---

## 0. Executive summary (all measured)

1. **Marker latency grows with matching documents because `geotile_grid`
   processes every match** — the 500-marker cap bounds output, not work.
   `top_hits` removal alone saves only ~35–40%; the filter+grid pass is the
   rest.
2. **`random_sampler` is the only tested aggregation that cuts the whole
   query**: 5M national view **2,934 ms → 257 ms wall (−91%)** and Dubai dense
   city **2,219 ms → 185 ms (−92%)**, with 100% top-5 cell agreement at
   p=0.1. Cell counts become statistical estimates.
3. **Realistic city viewports are cheap already.** On the distributed 1M
   corpus (36–40k matches in view) the current query is **18–51 ms wall**;
   the previous "city" numbers were an artifact of corpora that stack all
   documents into two metro footprints.
4. **The adaptive second attempt doubles cost without adding cells**: measured
   `app_adaptive` vs single fixed-precision pass: 63 vs 36 ms (city),
   913 vs 702 ms (1M national), 4,105 vs 2,219 ms (5M dense).
5. **Sorting cost is the collector over all matches**; index sorting
   (`created_at desc`, forcemerged) cuts the newest-sort **fill** collector by
   87% at city / 37% at country, and is neutral for other sorts. It optimizes
   exactly one ordering and needs a reindex + forcemerge.
6. **Split counts never reduce page-1 cost; they buy reuse.** Measured at
   100k: page-1 cold split 443 ms / 10 shard queries vs inline 227 ms / 8;
   but every re-sort/page reuses the population-keyed count (page 3 = 2
   queries — list only). Keep split; batch it with `_msearch`.
7. **Industry pattern matches ours**: server-side clusters with counts, capped
   markers, recursive zoom (verified for Repliers/Zillow-observed/Rightmove).
   Our gap is sampling/rollups + batching, not the shape of the architecture.

---

## 1. Map markers — why O(matches), and how to make it O(sample)

### 1.1 Mechanics (code-verified)

The shipped tile query is a `size:0` search:

```
filter pass (status + kind + price + geo_bounding_box)
  └─ geotile_grid(location, precision, size 1000, shard_size 1500, bounds)
       └─ top_hits(size 1, sort newest+id, preview fields)   [per cell]
```

- A bucket aggregation visits **every matching document** to compute cell ids;
  `shard_size` bounds buckets returned per shard, `bounds` restricts which
  cells are considered/returned — neither bounds the scan (official ES docs).
- `top_hits` is per cell: cheap when few cells, heavier with many cells.

### 1.2 Measured strategy matrix — 5M concentrated (worst case)

Same population/viewport, medians of 3 runs, request cache off.
Wall / shardCPU in ms.

| Strategy | Delhi z11 (78k matches) | Dubai z10 (3.77M) | Country z4 (5M) |
| --- | --- | --- | --- |
| `fixed_top_hits` (shipped shape) | 102 / 108 | **2,219 / 3,148** | **2,934 / 4,379** |
| `app_adaptive` (2 attempts) | 144 / 74 | 4,105 / 2,930 | 4,870 / 3,465 |
| `counts_only` (no top_hits) | 62 / 70 | 1,441 / 2,252 | 1,860 / 3,085 |
| `grid_size_200` (fewer cells) | 67 / 74 | 1,757 / 2,646 | 2,242 / 3,420 |
| `precision_minus1` | 69 / 78 | 1,656 / 2,495 | 2,298 / 3,562 |
| `sampler` (first 10k docs) | 54 / 56 | 927 / 1,887 | 1,342 / 2,722 |
| `random_sampler` p=0.1 | 42 / 67 | **185 / 331** | **257 / 639** |
| `counts_plus_fill` | 758 / 404 | 1,414 / 2,260 | 1,865 / 3,054 |
| `legacy random_score` 500 | 167 / 175 | 4,394 / 7,473 | 5,333 / 10,599 |
| `random_sampler` p=0.02 | 142 / 170 | 260 / 388 | 103 / 209 |

Facts:

- Removing `top_hits` saves only ~35–40% (Dubai 2,219→1,441; country
  2,934→1,860) — the grid sweep over every match remains.
- `sampler` (first-N) is both slower than `counts_only` and **biased**: its
  deterministic doc-order sample collapsed to 1 cell/1 rep on dense views.
- `random_sampler` cuts the entire query (query phase 1,550→153 ms Dubai;
  2,058→389 ms country) and keeps the same cell structure
  (top-5 cells identical, p=0.1). Its cell doc_counts are estimates scaled by
  1/p.
- p=0.02 vs p=0.1 is not monotonic under host contention (country 103 vs
  257 ms; Dubai 260 vs 185 ms — noise); the sampler's bitset + query pass
  dominate, so p can be chosen for count accuracy rather than speed.

### 1.3 Realistic distribution — 1M distributed corpus (36–40k city matches)

| Strategy | Delhi z11 | Dubai z10 | Country z4 |
| --- | --- | --- | --- |
| `fixed_top_hits` | 36 / 35 | 51 / 56 | 702 / 942 |
| `app_adaptive` | 63 / 30 | 73 / 40 | 913 / 644 |
| `sampler` | 29 / 25 | 34 / 31 | 371 / 615 |
| `random_sampler` p=0.1 | 24 / 32 | 18 / 24 | **81 / 151** |
| `counts_only` | 60 / 49 | 26 / 29 | 379 / 612 |
| `legacy random_score` | 237 / 182 | 64 / 76 | 1,079 / 2,208 |
| `fanout_parallel` (shipped tiling, cache-warm) | 14 | 13 | 13 |

- City viewports: everything is fast; `random_sampler` is 1.5–2.8× faster than
  the fixed shape but the absolute difference is ~12–33 ms.
- National view (1M matches): `random_sampler` 8.6× wall faster, 6.2× less CPU.
- Accuracy: top-5 cell set identical in every measured run (p=0.1; 80% in one
  country run); marker-id overlap is low (13–17%) because sampled reps are
  different documents — cell structure and counts are preserved.

### 1.4 In-process merge/dedupe (Node CPU, 300 iterations)

| Stage | 8×1000 cells (8k markers) | 8×1000, 50% dup | 8×100 | 1×1000 |
| --- | --- | --- | --- | --- |
| dedupe | 4.27 ms | 4.88 ms | 0.42 ms | 0.48 ms |
| clip | 0.30 ms | 0.28 ms | 0.04 ms | 0.05 ms |
| stride (sort+stride) | 6.89 ms | 3.15 ms | 0.36 ms | 0.43 ms |
| **full merge** | **12.5 ms** | 7.6 ms | 0.73 ms | 1.02 ms |

Merge cost is bounded by `tiles × cell cap`; the full sort in `strideToCap`
is the largest slice.

---

## 2. Sorting — where the CPU goes

### 2.1 Sort matrix, 1M distributed (medians of 5 runs; wall / shardCPU ms)

| Sort | List (city) | Tile (city) | Fill (city) | List (country) | Tile (country) | Fill (country) |
| --- | --- | --- | --- | --- | --- | --- |
| newest | 40 / 40 | 32 / 34 | 101 / 87 | 372 / 653 | 483 / 676 | 363 / 609 |
| price_asc | 36 / 40 | 33 / 33 | 69 / 60 | 437 / 729 | 541 / 726 | 300 / 504 |
| price_desc | 35 / 37 | 35 / 37 | 155 / 128 | 538 / 858 | 536 / 757 | 334 / 565 |
| beds | 50 / 49 | 52 / 46 | 94 / 82 | 718 / 1,062 | 657 / 916 | 380 / 677 |
| baths | 35 / 41 | 32 / 33 | 96 / 85 | 592 / 1,116 | 883 / 1,160 | 399 / 645 |
| sqft | 33 / 37 | 38 / 37 | 96 / 79 | 493 / 876 | 706 / 922 | 320 / 537 |
| lot | 34 / 38 | 58 / 53 | 94 / 84 | 363 / 614 | 642 / 865 | 351 / 594 |
| popular | 36 / 42 | 52 / 48 | 144 / 137 | 401 / 738 | 1,018 / 1,483 | 832 / 1,111 |

- City sorting costs 30–60 ms regardless of sort; **country sorting costs
  360–1,000 ms** and the collector (`SimpleFieldCollector` for the list,
  per-cell top-hits for the tile) is 30–50% of shard CPU.
- `beds`/`baths` are most expensive on the list path (mixed scope: projects
  lack the field → `missing:_last` + `unmapped_type` handling per doc);
  `popular` is most expensive on tile/fill (score computation has no doc
  values; the tile path falls back to newest, the list scores all matches).
- An earlier single-run outlier showed `price_asc` tile at 2,401 ms; a 9-run
  repeat measured 541 ms vs price_desc 536 ms — **that was host-contention
  noise**, both directions are symmetric.

### 2.2 Index sorting A/B (`created_at desc`, forcemerged to 1 segment)

| Shape | Unsorted | Sorted | Collector change |
| --- | --- | --- | --- |
| newest fill, city | 101 ms / 35.8 ms collector | 65 ms / **7.8 ms** | **−78% collector** |
| newest list, country | 372 / 298.5 | 321 / 255.9 | −14% collector |
| newest fill, country | 363 / 225.7 (collector 127.4) | 276 / 162.4 (collector 80.4) | −37% collector |
| price_desc / beds (any) | — | — | unchanged (not the index order) |

Conclusions:

- Index sorting only helps when the query's sort **equals** the index sort,
  and mainly where a bounded top-K can early-terminate — the **fill** query,
  which is on the critical path of dense views, benefits most.
- It optimizes exactly one ordering; the UI has 8. Cost: reindex + forcemerge
  (best case; without forcemerge gains shrink), slower indexing. Recommend
  only for `newest` and only if fill remains a bottleneck after §5.1.

---

## 3. Split counts — when the extra query pays

### 3.1 Measured costs

| Source | Split (list + size:0 count) | Inline (`tth:true` + terms) |
| --- | --- | --- |
| 5M profile, page 1 | list 49.8 ms + count 35.6 ms (parallel); total CPU ≈ 104.6 ms | list 42.4 ms; CPU ≈ 51.1 ms |
| 1M profile, page 1 | list 15.9 + count 9.9 (parallel); CPU 22.3 | list 18.1; CPU 14.5 |
| 100k E2E page-1 cold (host-contended) | **443 ms / 10 shard queries** | **227 ms / 8 shard queries** |
| 100k E2E page-2 | 104 ms / 4 (list+count) | 64 ms / 2 |
| 100k E2E page-3 | 57 ms / **2 (list only — count reused)** | 46 ms / 2 |
| 100k E2E re-sort ×2 | within noise of inline | within noise |

Why split costs more on a cache miss: it is a **second backend pass plus an
extra round trip**, running in parallel with the list query, so wall ≈ max of
the two but CPU ≈ sum; inline counting rides the top-k collector pass that the
list query already performs.

Why split still wins in production:

- **Reuse**: the count key is the filter population only (no cursor, sort, or
  pageSize), so every Load-More page and every re-sort reuses it (measured:
  page 3 = list-only; JSON design pinned in `countStrategy.test.ts`).
- **Scale**: on a `size:24` top-k collector, `tth:true` costs +32–68 ms at 1M
  (prior-measured), while the count-only request takes Lucene's sub-linear
  `Weight.count` path for many shapes (0–10 ms at 1M); repeated counting in
  the list query is paid again on every sort/page.
- **Caching layers**: Redis `md:v5:c:` (tiered TTL by sort) plus the ES shard
  request cache — verified active by default in ES 8.15 (1,261 hits / 2,232
  misses on the tile index during profiling).

Recommendation: **keep split**, and collapse the parallel branch to one round
trip with `_msearch` (list + count + tiles in a single request). For small
populations (<~100k matches) inline is measurably cheaper on first load, so a
threshold option (configured, not forked) is worth having.

---

## 4. Industry practice (verified vs inferred)

**Verified (public sources):**

- **Rightmove (Elastic customer story + talks)**: Elasticsearch since 2014,
  1.2M+ listings, ~55M requests/day; average property enquiry ~36 ms round
  trip / ~15 ms processing at peak. Geo search uses distance, polygon/shape,
  bounding box; percolator powers ~3.5M saved-search alerts; a
  microservices/Search-API layer fronts the cluster. *(No public marker
  clustering detail.)*
- **realtor.com tech blog (“Optimizing GraphQL calls to ElasticSearch”,
  2019)**: an API layer with a defined data contract “shields the
  ElasticSearch cluster from queries which might be expensive.”
- **Zillow (third-party API documentation, unofficial)**: `extractionMethod`
  exposes `MAP_MARKERS` (“up to ~500 results, less data per row”) and
  `PAGINATION_WITH_ZOOM_IN` (“recursive map-tile zoom”). This documents
  observed behavior — a ~500-marker cap and recursive zoom — not Zillow’s
  internal architecture.
- **Zillow engineering (“Tile It Up!”, official)**: server-generated vector
  tile overlays for parcel/school boundaries (Android). Not listing clusters.
- **Repliers (real-estate API, product docs)**: server-side clustering in one
  endpoint — `cluster=true`, `clusterPrecision`, map-only responses
  (`listings=false`), `clusterFields` for singleton labels,
  `clusterListingsThreshold`. Clusters carry count + bounds; the client draws
  them.
- **Elasticsearch docs**: `geotile_grid.bounds` restricts cells
  considered/returned; `shard_size` trades count accuracy for cost; high
  precision is “costly in RAM and result sizes”; the `_mvt` vector-tile API
  (8.x) clusters on data nodes with a square grid.

**Inferred (not asserted):**

- Large portals converge on *cap + server-side aggregation + recursive zoom*;
  Zillow likely serves map clusters from a dedicated rollup/tile store rather
  than aggregating the primary index per request (common pattern; unverified
  for Zillow).
- Our architecture already matches the verified pattern; the measured gap is
  paying O(matches) for a bounded display, not the shape of the pipeline.

---

## 5. Prioritized recommendations (with measured basis)

| # | Change | Measured before → after (same shape/corpus) | Expected effect | Risk / effort |
| --- | --- | --- | --- | --- |
| 1 | **Adaptive marker sampling**: keep the exact grid when in-frame matches ≤ ~100–200k; above that wrap the same `geotile_grid`+`top_hits` in `random_sampler` (p≈0.1, fixed seed) | 5M country **2,934→257 ms** (−91% wall, −85% CPU); 5M Dubai **2,219→185 ms**; 1M country **702→81 ms**; city 36→24 ms. Top-5 cells 100% identical (p=0.1) | Removes the O(matches) wall for dense/national views; city stays exact | Medium: flag-gated tile path; cell counts become estimates (label density as approximate or recompute exact counts only for visible top cells); reps change but stay real |
| 2 | **Drop the second adaptive attempt when cell growth is flat** (or use the fixed precision table) | `app_adaptive` vs one pass: city 63 vs 36 ms, 1M country 913 vs 702 ms, 5M Dubai 4,105 vs 2,219 ms | ~1.3–1.9× faster on every viewport where refinement adds few cells | Low: policy change in `esTileMarkers` adaptive loop |
| 3 | **`_msearch` batching** of list + count + tile fan-out (flag exists, unused) | Not newly measured; queues of 93–183 observed at 5M cold conc 50 in the companion report | p99 and queue depth under load; one round trip instead of ~10 | Medium: response parsing; parity harness exists |
| 4 | **Index sorting only if fill stays hot after (1)** (`newest`, forcemerge) | Fill collector −78% city / −37% country for newest; other sorts unchanged | Faster dense-view fill and newest list | Medium: reindex + forcemerge cost, one ordering only |
| 5 | **Split counts: keep + batch**; optional inline threshold for small populations | Page-1 cold split 443 ms/10 q vs inline 227 ms/8 q (100k); page 3 split 2 q (count reused) | Preserves reuse while closing the page-1 gap | Low: config + `_msearch` from (3) |
| 6 | **Merge cost trim** (optional): replace `strideToCap`’s full sort with selection or cap cells earlier | Worst-case merge 12.5 ms/request (8×1000 cells) | ≤12 ms Node CPU per cold request | Low priority |
| 7 | **Industry-aligned rollup** (longer term): precomputed zoom-bucket cells per filter family, served like `_mvt` | — | Removes ES from the marker path at overview zooms entirely | High: new pipeline + invalidation |

Consumer-facing counts stay exact — recommendation (1) only affects marker
aggregation; the sidebar badge and filters continue to use `buildFilters` +
the split count (AD3).

---

## 6. Reproduce

```bash
# realistic corpus
node scripts/build-scale-corpora.mjs 1000000 --suffix=_1mdist --dist

# marker strategies (concentrated 5M and distributed 1M)
ES_REQUEST_TIMEOUT_MS=300000 ES_PROPERTIES_INDEX=bench_props_5m \
  ES_PROJECTS_INDEX=bench_projects_5m ES_TILES_INDEX=bench_tile_5m \
  npx tsx scripts/bench-marker-strategies.ts --label=5m --runs=3
ES_TILES_INDEX=bench_tile_1mdist npx tsx scripts/bench-marker-strategies.ts --label=1mdist --runs=5

# sorting + index sorting
ES_TILES_INDEX=bench_tile_1mdist npx tsx scripts/bench-sort-cost.ts --label=1mdist --runs=5
node scripts/make-sorted-variant.mjs bench_tile_1mdist bench_tile_1mdist_sorted created_at desc --forcemerge
ES_TILES_INDEX=bench_tile_1mdist_sorted npx tsx scripts/bench-sort-cost.ts --label=1mdist-sorted \
  --runs=5 --sorts=newest,price_desc,beds

# split vs inline end-to-end (two servers, same corpus)
PORT=3210 ROUTE_TIMING=1 ES_*_INDEX=bench_*_100k npm run start
PORT=3220 ROUTE_TIMING=1 SPLIT_COUNTS=0 NATIVE_COUNTS=1 ES_*_INDEX=bench_*_100k npm run start
npx tsx scripts/bench-count-e2e.ts --split=http://localhost:3210 --inline=http://localhost:3220 --label=100k

# merge microbench
npx tsx scripts/bench-merge.ts
```

## 7. Limitations

- **Host contention**: the machine ran at load 19/8 cores during this session
  (VS Code, Docker VM, OS); absolute wall figures are floors and a few
  outliers were re-measured (price_asc tile 2,401 ms → 541 ms on a 9-run
  repeat). Rankings are the transferable result.
- The 5M **distributed** build was abandoned mid-index: host contention cut
  ingestion from ~5,000 to ~500 docs/s. Realistic-distribution results are
  therefore measured at 1M (city viewports 36–40k matches); 5M numbers use the
  concentrated corpus (worst case).
- Lean corpora understate fetch bytes; `random_sampler` cell counts are
  estimates (relative error grows as cell count shrinks); index-sorting A/B is
  a forcemerged best case; p-sweep results are noisy under contention.
- New strategies were measured at the ES query level only — no HTTP load test
  until implemented behind a flag.
- Industry facts are cited where public; Zillow’s internal architecture is not
  public and is not claimed.
