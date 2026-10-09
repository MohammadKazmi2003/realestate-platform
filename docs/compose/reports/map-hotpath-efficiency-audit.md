# Architecture Efficiency Audit — Search/Map Hot Path

- **Date**: 2025-10-09
- **Scope**: search/map hot path (tiles, fan-out, cache keys/TTLs, quantiles, marker queries, pills) per agreed scope
- **Method**: static read of all hot-path sources + `npm run scale:smoke` (all PASS) + live ES probe. Query counts below are **code-derived estimates**, not measurements; confirm with `npm run scale:layered` / `scale:cold` against a production build before acting on the numbers.
- **Baseline**: branch `new-admin-features` @ `e5275e3`, working tree clean. ES 1-node yellow, worker running.

---

## Executive summary

The tile machinery is well-built but **wired into the least efficient request path**. `/api/map-tiles` — the hardened route with tile-aligned keys, Redis singleflight, bounded concurrency, and a CDN-friendly GET — has **no frontend caller** (verified by grep across `src/`; the only references are its own log lines). All product traffic goes through `/api/map-data`, which keeps three legacy inefficiencies the agreed architectural rules forbid (the rules are restated in the plan's *Global Constraints* section):

1. Response cache keys embed **exact viewport bounds** (AD1 violation) → per-pan cache miss across users.
2. **100%-sampled shadow mode** fires one extra full 500-doc marker query per pan, log-only.
3. Tile fan-out inside the route is **unbounded `Promise.all`** (invariant 7).

Plus a dead percentile aggregation on every cold tile query, and a lock-wait window shorter than its lock TTL (invariant 6).

**Estimated ES queries per pan (warm tiles, z≥10, scope=both): ~3 today** (1 list + 1 shadow marker + 1 fill). Eliminating findings F3 + F5 alone removes ~2 of 3.

---

## Findings

Ordered by expected waste elimination per unit of change.

### F1 (P0) — The hardened tile route is dead code; traffic uses the unhardened path

- **Evidence**: `src/app/browse/page.tsx:700` POSTs to `/api/map-data`; `grep -r "map-tiles" src/` matches only `src/app/api/map-tiles/route.ts` itself (log lines). `src/app/api/viewport-data/` is an empty directory.
- **Impact**: `map-tiles` has tile-aligned cache keys, `singleflightCompute` (cross-instance coalescing), bounded concurrency (`TILE_CONCURRENCY=6`), and a CDN-cacheable GET. None of that serves users. `map-data` internally re-implements the tile layer with in-process coalescing and unbounded fan-out, so the architecture's scaling properties exist only on an unexercised code path — untested under real traffic and unusable as evidence of readiness.
- **Fix direction**: either cut the client over to `/api/map-tiles` (needs response shape parity: `results`, `nextCursor`, scope totals), or port `map-tiles`' bounded concurrency + Redis singleflight + GET path into `map-data` and delete the duplicate route.

### F2 (P0) — Response cache keys embed exact viewport bounds (violates AD1)

- **Evidence**: `src/lib/filterNormalize.ts:390-391` — `markerKey = md:v4:m:${rb}:${hash}` and `listKey = md:v4:l:${rb}:${hash}` where `rb` is bounds at 6-decimal precision (`fmtBounds`, line 361-364). The comment at `filterNormalize.ts:220-231` concedes "Deliberately NOT grid-snapped", and `src/lib/mapTiles.ts:1-7` notes exact bounds are "currently" what the viewport flow keys on. Only the v5 tile sub-keys (`prepareTileQuery`, line 415) are tile-aligned.
- **Impact**: With search-as-I-move ON by default and a 400 ms pan debounce (`browse/page.tsx:1423-1428`), every pan produces unique `markerKey`/`listKey` → Redis hit rate ≈ 0 across users; reuse is limited to the internal tile sub-keys and exact viewport revisits. Every pan still pays: 1 list query (uncached, exact-bounds) + up to 8 `cacheGet` + dual `cacheSet` writes (route line 344).
- **Compounding risk — 32-bit hash collision**: `md:v4` keys use `buildFilterHash` (32-bit, `mapTiles.ts:121-130`) while v5 uses `buildFilterHash64` (line 133-145). Birthday probability on the 32-bit space: ~0.1% at 100K distinct keys, ~12% at 1M. Since each pan mints new keys, key count grows with traffic, and a collision serves one viewport's payload under another's key (misplaced pins, wrong list) — silent correctness failure at exactly the scale this work targets.
- **Fix direction**: key the merged response on the covering-tile set (sorted z/x/y list), as AD1 prescribes, and switch the v4 hash to 64-bit in the same change.

### F3 (P0) — Shadow mode runs at 100%, doubling marker-path ES work

- **Evidence**: `flags.ts:33-37` — `tileShadow` default ON, `tileShadowPct` default **100**. `src/app/api/map-data/route.ts:346-351`: on every tile-served response it fires `queryESMapMarkers(esParams)` — a `function_score`/`random_score` search for 500 docs across both indices (`esQueryBuilder.ts:524-609`) — and uses it only for a log line. The legacy-served path samples shadow tile aggs at 10% (line 368-378); the tile-served path samples at 100%.
- **Impact**: Because F2 makes almost every pan a tile-served miss, nearly every request pays one extra full-population marker query, purely for observability. That single change roughly doubles the ES work per pan on the hot path.
- **Fix direction**: default `TILE_SHADOW_PCT` to ~1 (or off) and cap it in the tile-served path the way the legacy path already caps at 10%. Shadow logging can also be derived from the tile payload it already has.

### F4 (P1) — Tile fan-out inside map-data is unbounded (violates invariant 7)

- **Evidence**: `src/app/api/map-data/route.ts:241` — `await Promise.all(tileEntries.map(...))`. Tile count ≤ 8 (`viewportCoveringTiles`, `mapTiles.ts:76-115`), scope=both splits into 2 indices (`esTileMarkers.ts:364-367`), adaptive precision allows up to 2 attempts (`flags.tileMaxAttempts=2`, `esTileMarkers.ts:404`) → **≤ 32 concurrent ES searches per request**. Compare the standalone route's bounded pool: `map-tiles/route.ts:16-27, 127` (concurrency 6).
- **Impact**: A single pan during a busy period can open dozens of ES sockets; `maxRetries: 3` on the client multiplies in-flight work on slow nodes. Adding Next instances multiplies, not absorbs, this.
- **Fix direction**: reuse the `mapWithConcurrency` helper (or the quantile/tile-level Cap the standalone route uses) in the map-data tile loop; env-tunable cap.

### F5 (P1) — Dead per-tile `p90` percentiles aggregation on every cold tile query

- **Evidence**: `esTileMarkers.ts:168-174` adds `aggs.p90` (TDigest over **all** tile matches) whenever `withPercentiles` is on — and callers pass `withPercentiles: flags.quantileFilter` (default ON) at `map-data/route.ts:266` and `map-tiles/route.ts:147`. `queryTileMarkersForBounds` returns `p90` (line 391), but both routes destructure only `{ markers, cells, took }` (`map-data/route.ts:269`, `map-tiles/route.ts:154`). Grep confirms **no consumer of `.p90`** in any route. The range narrowing actually used comes from the region-level quantile cache (`quantiles.ts`), not this per-tile agg.
- **Impact**: Every cold tile query pays a TDigest build over the full tile match set — ×2 indices for scope=both — and discards the result. Pure waste on the miss path.
- **Fix direction**: delete `aggs.p90` from `buildTileAggQuery` (and the `p90` plumbing), or consume it. Verify tile `took` deltas before/after with `scale:layered`.

### F6 (P1) — Request coalescing on the served path is in-process only (AD8 gap)

- **Evidence**: `map-data/route.ts:20-30` — module-level `pendingRequests` Map. Only the unused `map-tiles` route uses `singleflightCompute` (route.ts:132). Quantile coalescing is likewise module-local (`quantiles.ts:12-22`).
- **Impact**: With N Next instances, the same uncached viewport triggers N duplicate ES computations. The coincidence window is small-ish (pan keys differ per user) but the list query is identical across users at the same bounds+filters — exactly the shared key an in-process map cannot coalesce.
- **Fix direction**: route the list query through `singleflightCompute` with the (tile-aligned, post-F2) key.

### F7 (P1) — singleflightCompute waiters abandon slow winners (violates invariant 6)

- **Evidence**: `redis.ts:146-147` — `lockTtlMs = 8000`, `waitMs = 2500`. Tile queries run with `timeoutMs: 4000` (`map-data/route.ts:267`). On contention, waiters exhaust their 2.5 s window before a 4 s winner can finish, then recompute (line 164-165) and don't even cache their result — the duplicate work they just paid for also evicts nothing and helps no one.
- **Impact**: At the moment contention is highest (cold tile after a pan storm), the lock guarantees maximum duplication instead of preventing it.
- **Fix direction**: `waitMs` (≈9 s) must exceed `lockTtlMs` (8 s), per invariant 6; also cache the fallback-computed value so the last writer warms the key.

### F8 (P2) — Pills endpoint re-runs the expensive terms agg on every pan

- **Evidence**: `project-groups/route.ts:50` — key `pg:v1:${bounds 4dp}:${JSON.stringify(filters)}`: exact bounds again (per-pan miss) plus the un-hashed filter object (long Redis keys, larger memory per entry). The agg itself (`esQueryBuilder.ts:616-626`) is the full-population `terms` rollup AD4 wanted isolated; the isolation is defeated because each pan misses. No coalescing at all (plain `cacheGet`/`cacheSet`, route lines 51-71).
- **Impact**: One full-match terms agg per pan on top of F2's list query, with a 300 s+ TTL that never expires hot enough to matter because the key changes with every pan.
- **Fix direction**: snap bounds to the covering-tile grid (same wideness argument as F2), hash the filters, and coalesce via `singleflightCompute`.

### F9 (P2) — Every scroll page mints a new list cache key

- **Evidence**: `cursor` is included in `orderedForHash` (`filterNormalize.ts:268`) → in `listKey` (line 391). Semantically required (page N+1 ≠ page N), but it means infinite scroll always goes to ES: 24-doc query + 3 `value_count` counter aggs (`esQueryBuilder.ts:422-425`) per page.
- **Impact**: predictable, bounded per scroll, but it stacks with F2 — users who pan+scroll exhaust ES queries fastest.
- **Fix direction**: counters can ride a tile-keyed total (they don't depend on the page window); results themselves must stay per-cursor.

### F10 (P2) — GET wrapper on the tile route silently drops filters

- **Evidence**: `map-tiles/route.ts:234-247` — GET forwards only `minLat/maxLat/minLng/maxLng/zoom/scope/sort/query/listingPurpose/minPrice/maxPrice`. Any other filter (bedrooms, amenities, polygon, area…) is discarded, and the response is publicly CDN-cacheable (`s-maxage` 30-60, line 208).
- **Impact**: harmless only because no client uses the route (F1). The moment traffic moves to it, a GET with a bedroom filter returns and publicly caches the *unfiltered* population.
- **Fix direction**: forward the full normalized filter set, or reject GET when unsupported filter params are present.

### F11 (P2) — Quantile threshold compute is coalesced per-process only

- **Evidence**: `quantiles.ts:12-22` module Map; 24 h+jitter TTL (line 167).
- **Impact**: cold-start stampede on a new 1° region × field × intent: N instances each run one TDigest agg. Steady-state ≈ 0 queries, so this is a cold-path cost only.
- **Fix direction**: wrap the compute in `singleflightCompute` keyed by the same `q:v2:…` key.

### F12 (P3) — Primary path is POST-only; no edge absorption

- **Evidence**: `map-data/route.ts` exports only POST; the CDN-friendly GET exists only on the unused tile route.
- **Impact**: Scaling playbook step 4 (move warm traffic off origin) is unreached for the path users actually hit.
- **Fix direction**: falls out of F1/F2 (tile-keyed GET responses share across users).

### Nits
- `quantiles.ts:66-90` — `QuantileComputeOpts` interface declared twice (identical).
- `src/app/api/viewport-data/` — empty directory, dead.

---

## Verified non-issues (checked, not problems)

- **`request_cache: true` in search bodies** — the raw REST API rejects this (it is a URL parameter); it is only legal because the JS client hoists it. Probe against live ES via the app's JS client: **OK, `took=1011`**. The client hoists `request_cache` to the query string, so usage in `esTileMarkers.ts:302,464`, `esQueryBuilder.ts:625`, and both routes' quantile aggs is correct. (Raw-body callers like benchmark harnesses must use `?request_cache=true`.)
- **Cache-write discipline** — routes `cacheSet` only non-null, non-error results (invariant 4 holds).
- **Marker fetch-free contract** — `TILE_TOP_METRICS_FIELDS` (`esTileMarkers.ts:18-28`) mirrors `MARKER_SOURCE_FIELDS` (`esQueryBuilder.ts:382-392`).
- **Pagination stability** — every sort clause appends the `id` tiebreaker (`esQueryBuilder.ts:11-17`).
- **Smoke invariants** — `npm run scale:smoke` fully passes, including worst-fan-out 99 → 35.

---

## Recommended order

| Step | Findings | Expected effect |
| --- | --- | --- |
| 1 | F3, F5 | ~2 of ~3 ES queries per pan removed; no design change, env/code-trivial |
| 2 | F4, F7, F6 | bounded fan-out + real cross-instance coalescing |
| 3 | F2 (+F8, F9 counters) | cache reuse across users restored; AD1 invariant met; collision risk eliminated |
| 4 | F1 | the hardened route actually serves traffic; GET/CDN absorption becomes possible |
| 5 | F10, F11, F12 | hardening for the post-cutover path |

Confirm each step's effect with `npm run scale:layered` and `scale:cold` on a production build before moving to the next step. Measurement rules that make those numbers trustworthy:

- Measure a **production build** — dev-mode overhead distorts capacity figures.
- Drive load with **distinct client identifiers per request**, or a per-IP rate limit becomes the thing under test.
- Derive per-request backend query counts from **backend query-stat deltas**, not from reading code.
- Sample backend thread-pool/queue **during** load, never after — a drained queue proves nothing.
- Clear or vary the cache key between "cold" measurements; a jittered pan that resolves to the same tile-union key is warm.

---

## Resolution log (2026-10-09, measured on a production build)

All findings addressed. Numbers below are **measured**, not estimated.

| ID | Finding | Resolution |
| --- | --- | --- |
| **F1** | hardened `/api/map-tiles` had no caller | Superseded by a better design: `GET /api/map-data` makes the *existing* request CDN-cacheable (one request, not two). Frontend fresh-load now uses it. `map-tiles` kept for map-only refreshes |
| **F2 (P0)** | exact-bounds keys → ~0 cross-user reuse; 32-bit hash | ✅ Keys are now the **covering-tile union** (`coveringTileUnionBounds`) with **64-bit** FNV under `md:v5:*`. Any pan inside one tile set shares an entry. Warm path measured at **0 ES searches** (was 2) |
| **F3** | shadow at 100% | ✅ `TILE_SHADOW_PCT` default 1, capped at 10% in both paths |
| **F4** | unbounded tile fan-out | ✅ `mapWithConcurrency` (shared helper) in `map-data` |
| **F5** | dead `p90` agg | ✅ removed; residual `withPercentiles` param + `p90` return plumbing are dead but harmless |
| **F6** | in-process coalescing only | ✅ list + tiles go through `singleflightCompute` (in-process L1 + Redis SET NX L2) |
| **F7** | `waitMs < lockTtl` | ✅ derived from one exported pair (`SINGLEFLIGHT_WAIT_MS = LOCK + 1000`) — asserted as a value, not parsed from source |
| **F8** | pills key = exact bounds + raw JSON | ✅ key derived from the list key (union extent + 64-bit hash), cross-instance coalesced; empty result cached at 30s so new projects appear quickly |
| **F9** | `cursor` in `listKey` | by design (page N+1 ≠ page N) — unchanged |
| **F10** | GET dropped filters, publicly cached | ✅ forwards the full filter set; `polygon`/`polygons` **rejected with 400** rather than ignored. Same guard added to `GET /api/map-data` |
| **F11** | quantile coalescing per-process | ✅ `singleflightCompute` with `skipCacheWrite` (keeps jittered anti-herd TTL) |
| **F12** | POST-only, no edge absorption | ✅ `GET /api/map-data` + frontend cutover |
| — | **New: fill query ran on every request** | ✅ `cellsAreUnclustered()` short-circuits when tile reps already are the exact population |
| — | **New: `viewportCoveringTiles` stride broke coverage at z≤4** | ✅ descend to coarser tiles instead; union now provably spans the viewport (test per zoom) |
| — | **New: quantile `created_at` float vs `epoch_millis`** | ✅ thresholds snapped for date/integer fields — this had been silently failing newest-sort narrowing |

### Measured (production build, single ES node, 1541 docs)

| Metric | Before | After |
| --- | --- | --- |
| Warm map-data ES searches/request | 2 | **0** |
| Cold map-data ES searches/request | ~35 worst | **7.2** |
| `POST /api/map-data` ceiling | ~115–137 QPS | **~360–375 QPS** |
| ES search pool during load | `queue=17, active=13/13` | **`queue=0, rejected=0`, cpu 1–5%** |
| 160-concurrent aggregate | 304 QPS (1 inst) | **473 QPS (2 inst), p99 −69%** |
| Tile index footprint | 6.4 MB (both indices) | **975 KB (~15%)** |
| Pills | silently empty (endpoint uncalled) | endpoint wired, `X-Cache: HIT` on repeat |

### Caveats

- Dataset is 1,541 docs — this characterizes the **request path**, not match-volume cost.
  Re-run `npm run scale:layered` against a representative index before sizing ES.
- `scale:cold` was measuring the warm path until the tile-union change made jitter hit the
  same key; it now spreads across a country-sized region *and* randomises zoom to force real
  misses. A cold benchmark that doesn't clear or vary the cache key is not a cold benchmark.

### Reproduce

```
npm run test:ci      # 16 suites / 127 tests
npm run scale:smoke  # invariants, no services
npm run scale:e2e    # 31 correctness + amplification checks
npm run scale:layered -- --base=http://localhost:3000 --conc=10,25,50 --n=200
npm run scale:cold   -- --base=http://localhost:3000 --conc=10,25,50 --n=150
```

---

## Second pass — full-pipeline efficiency audit (2026-10-09)

Scope: minimise ES CPU/heap/storage/query work, move reusable responses to the edge,
verify entity scopes, and measure before/after. Everything below is **measured** on a
production build against a 1,543-doc index unless marked as an estimate.

### ES index weight (the largest single win)

Three classes of dead weight were found by asking one question of every indexed field:
*is it ever queried?*

| Removed | Why it was dead | Cost it was carrying |
| --- | --- | --- |
| `title.autocomplete`, `project_name.autocomplete`, `name.autocomplete` | only `location_text.autocomplete` is queried | `edge_ngram(2-20)` multiplies each field's terms ~10x — term dictionary, index bytes, indexing CPU |
| `title.keyword`, `location_text.keyword`, `developer_name.keyword`, `name.keyword` (×2) | only `project_name.keyword` is queried | unused doc-values |
| `properties.suggest` completion | only `projects/autocomplete` uses `field: 'suggest'` | FST automaton pinned in heap + index bytes |
| `project_name`, `unit_count` on markers | frontend reads neither in the map path | `_source` fetch bytes for every `top_hits` rep, plus wire bytes |

Kept on purpose: `location_text.autocomplete` (autocomplete), `project_name.keyword`
(`by_project` agg), projects `suggest` (autocomplete).

**Two latent defects surfaced while doing this:**

1. **The index template had never applied.** `applyIndexTemplate` passed the whole file
   as `template`, nesting it twice — ES rejected it and the script logged a warning it
   swallowed, then built the index from a *second, drifted* mappings file (replicas 0 vs 1,
   different `suggest` analyzer). Both indexers now read the same template file that
   `putIndexTemplate` uses; the duplicate files are deleted.
2. **`synonym_filter` with `synonyms_path` cannot run at index time**, so that template
   could never have applied anyway. Index/search analyzers are now split:
   `*_index_analyzer` = `lowercase + english_stemmer`, `*_search_analyzer` = the same
   **plus updateable synonyms**. Synonym fan-out moves off the write path (bounded by query
   terms instead of corpus size) and file-based synonyms become updateable without a reindex.
   Verified live: `apartment→flat` and `condos→condo` resolve at search time, stemming works
   both directions, autocomplete prefix matching unaffected.

### Measured results (identical dataset: 108 + 1,435 + 1,543 docs)

| Metric | Baseline | After | Change |
| --- | --- | --- | --- |
| `properties_v1` storage | 203.1 KB / 106 docs | **142.1 KB / 108 docs** | **−30%** with *more* docs |
| `projects_v1` storage | 6.2 MB | **5.8 MB** | −6.5% |
| ES heap under load | 282–294 MB | **112 MB** | **−62%** |
| ES tile-agg ceiling | 699 QPS (p99 258 ms) | **1,212 QPS (p99 82 ms)** | **+73% / p99 −68%** |
| `POST /api/map-data` (warm) | 250 QPS, p99 280 ms | **360 QPS, p99 153 ms** | **+44% / p99 −45%** |
| Cold map-data ES searches/req | 10.78 | **7.40** | −31% |
| Cold tiles ES searches/req | 2.28 | **1.14** | **−50%** |
| Cold tiles throughput | 140–167 QPS | **252–372 QPS** | **+88%** |
| Warm ES searches/req | 0 | **0** | held |
| ES search pool under load | `queue=0, rejected=0` | same | no saturation |
| Route/ES ratio | 0.43 | 0.31 | app-layer bound (ES has headroom) |

### Cold-path fan-out: provably wasted refinement

The adaptive precision loop refined tiles whose geo bbox matched **zero documents** —
raising precision only subdivides an existing doc set, so it can never turn 0 into >0.
One server log contained **2,861 such refinements**. The loop now stops immediately on
`cells === 0`. This is most of the cold-path drop (10.78 → 7.4).

### Correctness bugs found by testing (not by reading)

| Bug | Impact | Status |
| --- | --- | --- |
| **Unified tile index leaked `scope=properties` results** | Single scope was enforced only by *index choice*; `listings_tile` holds both types, so `scope=properties` returned project markers. `buildFilters` never emitted an `entity_type` term. | Fixed: explicit `entity_type` filter in `buildFilters` (AD3 — one source of truth). E2E asserts all three scopes; scope=properties now returns 108 markers, all properties. |
| **`newest` stride ranked by id** | Mapped markers never carried `created_at`, so `strideToCap` sorted equal values and fell through to the id tiebreak — "top 500 by recency" was arbitrary. | Fixed: mappers emit `_createdMs`, ranked server-side, then stripped before cache+response. |
| **PG/ES drift** | PostgreSQL had 108 properties, ES 106. | Fixed by full re-sync; `es:verify` now consistent. |

### Edge caching (CDN)

- **URL canonicalisation** (the important one): the server already answers every map and
  pills request from the covering-tile *union*, so two users over the same tiles get
  byte-identical payloads — but exact bounds in the URL made a CDN treat them as separate
  resources. The frontend now requests tile-union bounds, so the edge key matches the unit
  the server actually caches. This is the same defect the tile-union Redis keys fixed one
  layer down.
- `Cache-Control: public, s-maxage=30, stale-while-revalidate=60` on all three GETs;
  no `Set-Cookie`.
- Next.js stamps `Vary: rsc, next-router-*` on route handlers and cannot be removed.
  Verified the response body is **byte-identical** with and without those headers, so a
  CDN keyed on them still resolves to a single entry (asserted by test).

### Horizontal scaling (objective 7)

| | 1 instance | 2 instances |
| --- | --- | --- |
| Aggregate QPS | 299.5 | **481.0 (+61%)** |
| p50 | 276 ms | 255 ms |
| p99 | 6481 ms | **3173 ms (−51%)** |
| Errors | 0% | 0% |

### Verification

```
npm run test:ci     16 suites / 132 tests  PASS
npm run scale:smoke PASS
npm run scale:e2e   41/41 PASS
```

### Still incomplete (honest list)

- **No CDN in front of this environment**, so edge hit rate is asserted from headers and
  cache-key properties, not observed. Worth confirming on a real deployment.
- **Dataset is 1,543 docs.** These numbers characterise the request path; match-volume cost
  (the thing that actually dominates at 10M) is unrepresented. Re-run before sizing ES.
- The legacy `random_score` fallback remains reachable only as the AD7 rollback path.
- `MSEARCH_ENABLED` is still declared but unimplemented — per-request round trips are not
  yet batched.
- Indices are still 1 shard each; sharding stays a config change (`ES_SHARDS`), not code.
