# Admin-1 selection on MapTiler geometry — outline and filter are the same shape

Date: 2026-10-12
Scope: state/emirate selection on `/browse` (hover, selection, listing filter)

## What changed

The interactive state selection now renders and filters by the canonical
MapTiler geocoding geometry itself:

- `scripts/build-maptiler-geo.mjs` snapshots all 43 regions (36 India states/UTs
  + 7 UAE emirates) from the MapTiler Geocoding API, validates anchors, and
  writes verbatim Polygon/MultiPolygon geometry (holes + islands included):
  - `public/geo/regions/<ID>.geojson` (canonical, 18.3 MB total, ≤48329 points,
    ≤282 rings, holes in 13 regions)
  - `public/geo/regions-manifest.json` (bbox, counts, sha256, version)
  - `public/geo/overview.geojson` (artifact-safe simplification, 2.9 MB raw /
    1.24 MB gzip — background layer only)
- **No `admin1_id`, no classification, no backfill.** `admin1Classify`,
  `admin1-classify.cjs`, `es-admin1-backfill.mjs`, and the mapping entries in
  the three ES templates were removed. Indexing is unchanged otherwise.
- The ES filter is a `geo_polygon` over the exact shapes; holes compile to
  `bool { filter: outer, must_not: holes }` per polygon, polygons union via
  `should` (`boundaryClauseFromShapes` in `src/lib/esQueryBuilder.ts`).
- Cache keys use a region token (`<id>:<sha256[0..32]>`) instead of hashing the
  polygon; the payload still carries the full geometry to ES.
- Client hover/selection fetch canonical geometry once per id
  (`/api/admin-geo?state=ID&v=<sha>`), cached in memory + HTTP immutable;
  visible regions are prefetched after idle zoom (≤2, saveData-aware).
- Attribution `© MapTiler © OpenStreetMap contributors` is stored in the
  manifest/features; product decision was to treat the stored geometry as
  permitted (MapTiler Terms §6.3/§6.4 allow Geocoding API export with
  attribution; §7.2 server-caching language is the residual ambiguity).

## Measured cost per state (live ES, production build, `bench-results/state-geo-latency.json`)

43 regions, `_search` size:0 with the exact server clause:

| metric (ms) | p50 | p95 | max |
| --- | --- | --- | --- |
| ES cold (`request_cache=false`) | 70 | 456 | 1298 (IN-AN, 48.3k pts) |
| ES warm (shard request cache) | 74 | 463 | 1010 |
| API cold (cache flushed, full request) | 95 | 465 | 981 |
| API warm (Redis) | 8 | 18 | 26 |

Worst cold states: IN-AN 1298 ms (48.3k pts/282 rings), IN-MH 477 ms,
IN-WB 456 ms, IN-KA 296 ms, IN-MP 283 ms. UAE emirates (≤775 pts) are 8–46 ms.
Counts were identical across ES cold/warm and API cold/warm for all 43.

Earlier 0.5–2 s estimates were pessimistic for the MapTiler shapes: most Indian
states land at 35–300 ms cold because candidate sets are small; only Andaman
(282 islands traced at full precision) crosses 1 s. Repeats are 5–26 ms warm.

Hash cost avoided by the region token (buildFilters + count key, IN-AN):
**5.7 ms with token vs 53.1 ms without** per key build — the list path builds
several keys per request.

## Known shape deviations (accepted, recorded)

- UAE emirates are MapTiler sea envelopes: Dubai 307 pts (7,226 km² envelope vs
  ~3,973 km² land, ×1.82), Abu Dhabi ×1.42, Sharjah ×2.32 (includes an offshore
  polygon at 53.98°E), Ajman ×1.89, Fujairah ×1.70, RAK ×1.50, UAQ ×1.86.
- IN-JK merges `region.822` (post-2019 J&K) + Ladakh `region.1854` to preserve
  the previous coverage (the product has no separate Ladakh chip).
- IN-DN and IN-DD share the combined DNH & DD `region.716` (merged UT since
  2020); MapTiler no longer returns Daman and Diu separately.
- Andaman is the largest canonical asset (1.81 MB raw / 724 KB gzip); IN-MP,
  IN-WB, IN-UP, IN-MH are 1.0–1.7 MB raw (400–710 KB gzip).

## Verification (all green)

- `jest`: 156/156 (new: anchors incl. Palm/World Islands/Leh/mahe/yanam, hole
  semantics, cap compliance, normalization preserves canonical geometry exactly,
  hole-aware clause construction, token key equivalence; removed classification
  tests)
- `npm run verify:states`: ALL PASS (83 checks) — state-counts and map-data
  totals equal local hole-aware PIP for 9 states; every result is PIP-inside;
  hole-interior probes excluded by the exact server clause; metro boxes
  (Mumbai/Pune/Bangalore/Hyderabad/Delhi/Dubai) fully included; unknown ids 400
- Playwright `state-selection`: 2/2 (hover tooltip + count, canonical geometry
  fetch with sha cache-bust on hover, click → chip → zoom → listings, clear)
- `scale:e2e`: 50/50
- `scale:smoke`: passed (fan-out 99 → 35)

## Known issues fixed during rollout

- Re-setting the hover GeoJSON source on every mousemove re-parsed the
  multi-MB geometry and froze headless Chromium; hover application is now
  guarded to fire only when the hovered id changes.
- The overview fill layer must never be filtered for hover (it is the
  pointer-events surface); an overview feature-state flag (`detail`) stands the
  coarse fill down while canonical geometry renders instead.

## Rollback

`scripts/build-admin-geo.mjs` (geoBoundaries/geohacker sources) is kept as the
revert path for the assets; reverting also needs the tenant `map.admin1.file`
value pointed back and the routes restored (`admin1Id` term path). No ES
mapping/index changes are required in either direction.
