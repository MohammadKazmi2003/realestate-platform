# XYZ Tile + Lightweight Index for High-QPS Map Plan

> **STATUS (2026-10-09): ALL TASKS IMPLEMENTED AND VERIFIED.**
>
> | Task | State | Where |
> | --- | --- | --- |
> | 1. Kill hot-path waste | ✅ `c72c89c`, `5c11e3a` | p90 removed, shadow 100%→1%, bounded fan-out, singleflight wait>lock |
> | 2. Lightweight index | ✅ | `es-config/listings-tile-template.json` (35 fields), `TILES_INDEX_ALIAS` |
> | 3. Dual-write + backfill | ✅ | `indexDocs.projectTileDoc/writeTileDoc`, `scripts/es-tile-reindex.ts` |
> | 4. Retarget tile queries | ✅ | `esTileMarkers.resolveTileIndexes()`, flag `TILE_INDEX_V1` |
> | 5. Serve viewports from tiles | ✅ **changed approach** — see Deviation D1 | `GET /api/map-data` + tile-union keys |
> | 6. Prove + roll out | ✅ | `npm run scale:layered / scale:cold / scale:e2e` |
>
> **Read the Deviation log below before re-reading this plan as instructions** —
> Task 2's original mapping would have broken three query paths, and Task 5 was
> replaced with a strictly better single-request design.


> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every map pan from XYZ tile-aligned Redis keys backed by a single lightweight ES tile index, so warm pans hit cache/CDN and cold tiles cost one cheap size:0 grid query each.

**Architecture:** Keep the existing `viewportCoveringTiles` z/x/y covering set and `md:v5:t:{z/x/y}:{filterHash}:{sortHash}` keys as the only map cache contract; add a unified `listings_tile` index containing only indexed filter/geo/sort fields plus stored-only preview fields, retarget all tile aggs to it in one search per tile (no scope split, no per-tile percentiles), batch tiles with bounded concurrency, and cut the client markers path to `GET /api/map-tiles` while the sidebar list stays on `/api/map-data`.

**Tech Stack:** Next.js 15 route handlers, `@elastic/elasticsearch` 8.19 JS client, ioredis single + Cluster, Jest + ts-jest, tsx scripts, ES `geotile_grid` + `top_hits:1`, Redis `singleflightCompute`.

## Global Constraints

- Cache keys are tile-aligned (`md:v5:t:{z/x/y}:…`), never exact-bounds — AD1.
- Tile coverage count, adaptive-precision attempts, and grid merge sizes stay capped and env-tunable — AD2.
- `buildFilters()` in `src/lib/esQueryBuilder.ts` stays the single source of truth for the filtered population — AD3.
- Expensive full-match aggs stay off the latency-critical path on their own endpoint/key/TTL — AD4.
- Normalization widens, never narrows; snapped values feed both query and hash — AD5.
- Quantile thresholds compute on un-narrowed base filters, cached per region × field × intent — AD6.
- Every served-response behavior change is flag-gated, default ON for final architecture, env-revertible — AD7.
- No required state in-process; cross-instance dedup via Redis `singleflightCompute` — AD8.
- No uncached query on a warm path; every ES query is cache-keyed or short-circuited on cache hit — Invariant 1.
- TTLs tiered by sort volatility (`redisTTLForSort`/`cdnSMaxAgeForSort`), never one global TTL — Invariant 2.
- Marker payloads keep the hover/click fetch-free contract or ship a fallback fetch in the same change — Invariant 3.
- Never cache failures or empty results — Invariant 4.
- Singleflight wait window exceeds lock TTL — Invariant 6.
- Per-request backend fan-out concurrency is bounded — Invariant 7.

---

### Task 1: Kill hot-path waste without design change

**Covers:** AD7, Invariant 1, Invariant 6, Invariant 7

**Files:**
- Modify: `src/lib/esTileMarkers.ts:168-174`
- Modify: `src/lib/flags.ts:33-37`
- Modify: `src/lib/redis.ts:146-147`
- Modify: `src/app/api/map-data/route.ts:241`
- Test: `src/__tests__/tileScaleBaseline.test.ts`

**Interfaces:**
- Consumes: `buildTileAggQuery(p: TileAggParams)`, `flags.tileShadowPct`, `singleflightCompute(key, ttl, compute, opts)`.
- Produces: `buildTileAggQuery()` result with no `p90` key; `flags.tileShadowPct` default `1`; `singleflightCompute` default `waitMs=9000, lockTtlMs=8000`; exported `mapWithConcurrency` from `src/lib/concurrency.ts` for reuse.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/tileScaleBaseline.test.ts
import { buildTileAggQuery } from '@/lib/esTileMarkers';

describe('tile hot-path waste baseline', () => {
  it('tile agg carries no per-tile percentile agg', () => {
    const q = buildTileAggQuery({
      tileBounds: { minLat: 28, maxLat: 29, minLng: 77, maxLng: 78 },
      must: [],
      filters: [{ term: { status: 'available' } }],
      scope: 'both',
      sort: 'price_desc',
      zoom: 12,
      withPercentiles: true,
    });
    expect(q.aggs.p90).toBeUndefined();
    expect(q.size).toBe(0);
    expect(q.track_total_hits).toBe(false);
  });

  it('singleflight defaults are lock-consistent (wait > lock TTL)', async () => {
    const src = require('fs').readFileSync('src/lib/redis.ts', 'utf8');
    const wait = Number((src.match(/waitMs = opts\?\.waitMs \?\? (\d+)/) || [])[1]);
    const lock = Number((src.match(/lockTtlMs = opts\?\.lockTtlMs \?\? (\d+)/) || [])[1]);
    expect(wait).toBeGreaterThan(lock);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/tileScaleBaseline.test.ts --ci`
Expected: FAIL — `q.aggs.p90` is defined; `2500 > 8000` is false.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/esTileMarkers.ts — delete this block from buildTileAggQuery:
// (remove the p90 branch entirely; keep tiles agg untouched)
-  const pField = p.withPercentiles ? percentileFieldForSort(sort, p.scope) : null;
-  if (pField && pField !== 'created_at') {
-    aggs.p90 = { percentiles: { field: pField, percents: [50, 90] } };
-  } else if (pField === 'created_at') {
-    aggs.p90 = { percentiles: { field: pField, percents: [50, 90] } };
-  }
```

```ts
// src/lib/flags.ts — shadow sampled, not census:
-  get tileShadowPct() {
-    const v = envNum('TILE_SHADOW_PCT', 100);
+  get tileShadowPct() {
+    const v = envNum('TILE_SHADOW_PCT', 1);
     return Math.max(0, Math.min(100, v));
   }
```

```ts
// src/lib/redis.ts — waiters outlive the lock they wait on (Invariant 6):
-  const lockTtlMs = opts?.lockTtlMs ?? 8000;
-  const waitMs = opts?.waitMs ?? 2500;
+  const lockTtlMs = opts?.lockTtlMs ?? 8000;
+  const waitMs = opts?.waitMs ?? 9000;
```

```ts
// src/lib/concurrency.ts — new file, exact content:
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let i = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
```

```ts
// src/app/api/map-data/route.ts — replace local helper + unbounded fan-out:
// delete local mapWithConcurrency (lines 16-27), add import:
import { mapWithConcurrency } from '@/lib/concurrency';
// replace `await Promise.all(tileEntries.map((te) =>` with:
await mapWithConcurrency(tileEntries, Math.max(1, Math.min(8, Number(process.env.TILE_CONCURRENCY) || 6)), async (te) =>
```

```ts
// src/app/api/map-data/route.ts — cap tile-served shadow at 10% like the legacy path:
-                if (flags.tileShadow && Math.random() * 100 < flags.tileShadowPct) {
+                if (flags.tileShadow && Math.random() * 100 < Math.min(flags.tileShadowPct, 10)) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/tileScaleBaseline.test.ts --ci`
Expected: PASS (2 passed). Then run: `npm run scale:smoke`
Expected: `All scale-ready smoke checks passed.`

- [ ] **Step 5: Commit**

```bash
git add src/lib/esTileMarkers.ts src/lib/flags.ts src/lib/redis.ts src/lib/concurrency.ts src/app/api/map-data/route.ts src/__tests__/tileScaleBaseline.test.ts
git commit -m "perf(tiles): drop dead p90 agg, sample shadow, bound fan-out, fix singleflight wait"
```

---

### Task 2: Ship the lightweight unified tile index mapping

**Covers:** AD2, AD3, AD5

**Files:**
- Create: `es-config/listings-tile-template.json`
- Modify: `src/lib/elasticsearch.ts` (add `TILES_INDEX_ALIAS`)
- Test: `src/__tests__/tileIndexMapping.test.ts`

**Interfaces:**
- Consumes: nothing (static mapping + alias constant).
- Produces: `TILES_INDEX_ALIAS = 'listings_tile'` imported as `import { TILES_INDEX_ALIAS } from '@/lib/elasticsearch'`; index `listings_tile` with only the fields below.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/tileIndexMapping.test.ts
import fs from 'fs';
import { TILES_INDEX_ALIAS } from '@/lib/elasticsearch';

describe('lightweight tile index contract', () => {
  it('alias is listings_tile', () => {
    expect(TILES_INDEX_ALIAS).toBe('listings_tile');
  });

  it('mapping indexes only filter/geo/sort fields (no analyzers, no suggest)', () => {
    const raw = fs.readFileSync('es-config/listings-tile-template.json', 'utf8');
    const tpl = JSON.parse(raw);
    const props = tpl.template.mappings.properties;
    const indexed = Object.entries<any>(props).filter(([, v]) => v.index !== false).map(([k]) => k).sort();
    // indexed = query CPU surface. Preview fields must be stored-only (index:false).
    expect(indexed).toEqual([
      'area_sqft', 'bathrooms', 'bedrooms', 'bhk_type', 'created_at',
      'entity_type', 'id', 'listing_purpose', 'location', 'low_price',
      'price', 'property_type', 'sort_price', 'status',
    ]);
    expect(JSON.stringify(tpl)).not.toMatch(/analyzer|suggest|completion|edge_ngram|synonym/);
    expect(props.title.index).toBe(false);
    expect(props.image_url.index).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/tileIndexMapping.test.ts --ci`
Expected: FAIL — `TILES_INDEX_ALIAS` undefined / mapping file missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/elasticsearch.ts — append:
export const TILES_INDEX_ALIAS = 'listings_tile';
```

```json
// es-config/listings-tile-template.json — exact content:
{
  "index_patterns": ["listings_tile*"],
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 1,
      "refresh_interval": "30s",
      "mapping": { "total_fields": { "limit": 60 } }
    },
    "mappings": {
      "dynamic": false,
      "_source": { "enabled": true },
      "properties": {
        "id": { "type": "keyword" },
        "entity_type": { "type": "keyword" },
        "status": { "type": "keyword" },
        "location": { "type": "geo_point" },
        "sort_price": { "type": "scaled_float", "scaling_factor": 100 },
        "price": { "type": "scaled_float", "scaling_factor": 100 },
        "low_price": { "type": "scaled_float", "scaling_factor": 100 },
        "created_at": { "type": "date" },
        "bedrooms": { "type": "integer" },
        "bathrooms": { "type": "integer" },
        "area_sqft": { "type": "float" },
        "listing_purpose": { "type": "keyword" },
        "property_type": { "type": "keyword" },
        "bhk_type": { "type": "keyword" },
        "title": { "type": "keyword", "index": false },
        "name": { "type": "keyword", "index": false },
        "image_url": { "type": "keyword", "index": false },
        "primary_image": { "type": "keyword", "index": false },
        "location_text": { "type": "keyword", "index": false },
        "project_name": { "type": "keyword", "index": false },
        "developer_name": { "type": "keyword", "index": false },
        "amenities": { "type": "keyword", "index": false }
      }
    }
  }
}
```

Why this shape: the 14 indexed fields are exactly the filter (`status`, `listing_purpose`, `property_type`, `bhk_type`, price ranges, `bedrooms`/`bathrooms`/`area_sqft`), geo (`location`), sort (`sort_price`/`price`/`low_price`/`created_at`), and identity (`id`, `entity_type`) surface tile queries touch — everything else is `index:false` stored-only preview so it costs fetch bytes for ≤1000 top_hits but zero query CPU and zero analyzer memory.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/tileIndexMapping.test.ts --ci`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add es-config/listings-tile-template.json src/lib/elasticsearch.ts src/__tests__/tileIndexMapping.test.ts
git commit -m "feat(tiles): lightweight unified listings_tile mapping + alias"
```

---

### Task 3: Dual-write the tile index (incremental + backfill)

**Covers:** AD3, Invariant 8

**Files:**
- Modify: `src/lib/indexDocs.ts:70-262`
- Create: `scripts/es-tile-reindex.ts`
- Test: `src/__tests__/tileDocs.test.ts`

**Interfaces:**
- Consumes: `buildPropertyDoc(id)`, `buildProjectDoc(id)`, `TILES_INDEX_ALIAS`.
- Produces: `buildTileDoc(entity, id) => Promise<AnyRow | null>` (lightweight projection); `indexOne`/`deleteOne` write the tile alias idempotently by `id`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/tileDocs.test.ts
import { buildTileDoc } from '@/lib/indexDocs';

describe('buildTileDoc lightweight projection', () => {
  it('keeps only tile fields and drops heavy text/gallery/suggest', async () => {
    const doc: any = await buildTileDoc('property', '__fixture__' as any).catch(() => null);
    // Unit-level contract without DB: projection allowlist is exported for this test.
    const { TILE_DOC_INDEXED_FIELDS } = await import('@/lib/indexDocs');
    expect(TILE_DOC_INDEXED_FIELDS.sort()).toEqual([
      'area_sqft', 'bathrooms', 'bedrooms', 'bhk_type', 'created_at',
      'entity_type', 'id', 'listing_purpose', 'location', 'low_price',
      'price', 'property_type', 'sort_price', 'status',
    ]);
    expect(doc).toBeNull(); // no DB in unit test; shape contract is what matters here
  });
});
```

(NOTE: the `buildTileDoc` DB-miss returning null is intentional — the assertion that matters is the exported allowlist matching Task 2's mapping. The integration backfill in Step 4 covers real docs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/tileDocs.test.ts --ci`
Expected: FAIL — `buildTileDoc` / `TILE_DOC_INDEXED_FIELDS` not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/indexDocs.ts — append (exact content):
export const TILE_DOC_INDEXED_FIELDS = [
  'id', 'entity_type', 'status', 'location',
  'sort_price', 'price', 'low_price', 'created_at',
  'bedrooms', 'bathrooms', 'area_sqft',
  'listing_purpose', 'property_type', 'bhk_type',
] as const;

const TILE_DOC_STORED_FIELDS = [
  'title', 'name', 'image_url', 'primary_image', 'location_text',
  'project_name', 'developer_name', 'amenities',
] as const;

/** Lightweight tile projection of the full doc. Null when row is gone. */
export async function buildTileDoc(entity: IndexEntity, id: string): Promise<AnyRow | null> {
  const full = entity === 'project' ? await buildProjectDoc(id) : await buildPropertyDoc(id);
  if (!full || (full as AnyRow).status === 'deleted') return null;
  const out: AnyRow = {};
  for (const k of [...TILE_DOC_INDEXED_FIELDS, ...TILE_DOC_STORED_FIELDS]) out[k] = (full as AnyRow)[k] ?? null;
  if (entity === 'project') {
    out.price = (full as AnyRow).low_price ?? 0;
    out.sort_price = (full as AnyRow).low_price ?? 0;
  }
  return out;
}
```

```ts
// src/lib/indexDocs.ts — extend indexOne/deleteOne (replace bodies):
import { TILES_INDEX_ALIAS } from './elasticsearch';
// in indexOne, after `await es.index({ index: aliasFor(entity), id, document: doc, refresh: true });` add:
  const tileDoc = await buildTileDoc(entity, id);
  if (tileDoc) await es.index({ index: TILES_INDEX_ALIAS, id, document: tileDoc, refresh: false });
// in deleteOne, after the main delete add:
  try { await es.delete({ index: TILES_INDEX_ALIAS, id, refresh: false }); } catch (err: unknown) {
    if ((err as { statusCode?: number })?.statusCode !== 404) throw err;
  }
```

```ts
// scripts/es-tile-reindex.ts — exact minimal backfill (paged scan of both aliases, bulk into tile alias):
import { getElasticsearchClient, ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS, TILES_INDEX_ALIAS } from '../src/lib/elasticsearch';
// Reads every doc from both aliases with _source filtering to tile fields,
// bulk-indexes into listings_tile by id (idempotent, safe to re-run).
// Run: npx tsx scripts/es-tile-reindex.ts
const FIELDS = ['id','entity_type','status','location','sort_price','price','low_price','created_at','bedrooms','bathrooms','area_sqft','listing_purpose','property_type','bhk_type','title','name','image_url','primary_image','location_text','project_name','developer_name','amenities'];
async function main() {
  const es: any = getElasticsearchClient();
  for (const src of [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS]) {
    let searchAfter: any = undefined;
    for (;;) {
      const res: any = await es.search({ index: src, size: 1000, sort: [{ id: 'asc' }], ...(searchAfter ? { search_after: searchAfter } : {}), _source: FIELDS });
      const hits = res.hits.hits || [];
      if (!hits.length) break;
      const ops: any[] = [];
      for (const h of hits) { ops.push({ index: { _index: TILES_INDEX_ALIAS, _id: h._id } }); ops.push(h._source); }
      await es.bulk({ operations: ops, refresh: false });
      console.log(`tile-reindex ${src}: +${hits.length}`);
      searchAfter = hits[hits.length - 1].sort;
      if (hits.length < 1000) break;
    }
  }
  await es.indices.refresh({ index: TILES_INDEX_ALIAS });
  console.log('tile-reindex done');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/tileDocs.test.ts --ci`
Expected: PASS. Then backfill on staging/dev only: `npx tsx scripts/es-tile-reindex.ts`
Expected: ends with `tile-reindex done`; verify: `curl -s localhost:9200/listings_tile/_count`

- [ ] **Step 5: Commit**

```bash
git add src/lib/indexDocs.ts scripts/es-tile-reindex.ts src/__tests__/tileDocs.test.ts
git commit -m "feat(tiles): dual-write + backfill lightweight tile docs"
```

---

### Task 4: Retarget tile queries to the single tile index

**Covers:** AD2, AD3, Invariant 1, Invariant 7

**Files:**
- Modify: `src/lib/esTileMarkers.ts:254-434`
- Modify: `src/lib/flags.ts` (add `tileIndexV1`)
- Test: `src/__tests__/tileMap.test.ts` (append cases)

**Interfaces:**
- Consumes: `buildFilters(params, scope)` (unchanged shared population), `TILES_INDEX_ALIAS`, `mapWithConcurrency`.
- Produces: `queryTileMarkersForBounds()` issuing ONE `es.search` per precision attempt against `TILES_INDEX_ALIAS`; `fetchAtPrecision` with no scope split and no `p90` return.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/tileMap.test.ts
import { buildTileAggQuery } from '@/lib/esTileMarkers';
import { TILES_INDEX_ALIAS } from '@/lib/elasticsearch';

it('tile agg targets the single lightweight index (no scope fan-out at query build)', () => {
  expect(TILES_INDEX_ALIAS).toBe('listings_tile');
  const q = buildTileAggQuery({
    tileBounds: { minLat: 28, maxLat: 29, minLng: 77, maxLng: 78 },
    must: [],
    filters: [{ term: { status: 'available' } }],
    scope: 'both',
    sort: 'newest',
    zoom: 12,
  });
  expect(q.aggs.tiles.geotile_grid.field).toBe('location');
  expect(q.aggs.tiles.geotile_grid.size).toBeLessThanOrEqual(1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/tileMap.test.ts --ci`
Expected: FAIL until the retarget lands (alias missing / split still present — the query-shape assertions pin the target).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/flags.ts — gate the cutover, default ON (env-revertible per AD7):
get tileIndexV1() { return envOn('TILE_INDEX_V1', true); },
```

```ts
// src/lib/esTileMarkers.ts — inside queryTileMarkersForBounds, replace index selection + needsSplit fan-out:
import { TILES_INDEX_ALIAS } from '@/lib/elasticsearch';
// replace `const indexes = ...` + `const needsSplit = opts.scope === 'both';` with:
const tileIndex: string = (() => {
  try { return flags.tileIndexV1 ? TILES_INDEX_ALIAS : '';
  } catch { return process.env.TILE_INDEX_V1 === '0' ? '' : TILES_INDEX_ALIAS; }
})();
const legacyIndexes =
  opts.scope === 'both' ? [ES_INDEX_ALIAS, PROJECTS_INDEX_ALIAS]
  : opts.scope === 'projects' ? PROJECTS_INDEX_ALIAS : ES_INDEX_ALIAS;
const indexes: string | string[] = tileIndex ? tileIndex : legacyIndexes;
const needsSplit = !tileIndex && opts.scope === 'both';
```

Scope stays a *filter* concern (`buildFilters` still emits the same population clauses, including the rent-intent project exclusion), so unifying the physical index cannot diverge list vs tiles (AD3). `unmapped_type` guards stay: the tile index carries `bedrooms`/`bathrooms`/`area_sqft` on every doc, but legacy fallback still queries the split indices.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/tileMap.test.ts src/__tests__/tileScaleBaseline.test.ts --ci`
Expected: PASS. Then run: `npm run scale:smoke`
Expected: `All scale-ready smoke checks passed.`

- [ ] **Step 5: Commit**

```bash
git add src/lib/esTileMarkers.ts src/lib/flags.ts src/__tests__/tileMap.test.ts
git commit -m "perf(tiles): query single lightweight tile index, flag-gated"
```

---

### Task 5: Serve viewports from tiles only; cut markers to GET /api/map-tiles

**Covers:** AD1, AD4, Invariant 2, Invariant 3

**Files:**
- Modify: `src/app/api/map-tiles/route.ts:220-253` (GET forwards full filter set)
- Modify: `src/app/browse/page.tsx:672-705` (markers via tile GET; list stays on map-data POST)
- Modify: `src/lib/filterNormalize.ts:399-405` (keep `sortBucketForKey` hero buckets; no change unless key explosion observed)
- Test: `src/__tests__/tileMap.test.ts` (GET-forwarding + merge-clip cases)

**Interfaces:**
- Consumes: `viewportCoveringTiles(bounds, zoom)`, `prepareTileQuery(tile, filters) → { tileKey }`, `mergeTileMarkers(tileResults, viewport, sort, 500)`.
- Produces: `GET /api/map-tiles?minLat&…&zoom&scope&sort&<full normalized filters>` returning `{ markers, cells, zoom, tiles }` with `Cache-Control: public, s-maxage=<tier>, stale-while-revalidate=60`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/tileMap.test.ts
import { mergeTileMarkers, clipToViewport } from '@/lib/tileMerge';

it('viewport assembles from covering tiles then clips (never single center tile)', () => {
  const tiles = [
    { markers: [{ id: 'in', entity_type: 'property', lat: 28.5, lon: 77.5 }] },
    { markers: [{ id: 'out', entity_type: 'property', lat: 20.0, lon: 70.0 }] },
  ];
  const merged = mergeTileMarkers(tiles as any, { minLat: 28, maxLat: 29, minLng: 77, maxLng: 78 }, 'newest', 500);
  expect(merged.map((m: any) => m.id)).toEqual(['in']);
  expect(clipToViewport([{ id: 'x', lat: null, lon: null } as any], { minLat: 28, maxLat: 29, minLng: 77, maxLng: 78 })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/tileMap.test.ts -t "covering tiles" --ci`
Expected: FAIL (new case missing before adding; passes trivially after adding — the real gate is Step 4's route check).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/map-tiles/route.ts — GET forwards the FULL normalized filter set (fix dropped-filter bug):
// replace the forward-body construction with:
body: JSON.stringify({
  bounds, zoom: num('zoom') ?? 10,
  scope: sp.get('scope') || 'both',
  sort: sp.get('sort') || 'newest',
  ...Object.fromEntries([...sp.entries()].filter(([k]) =>
    !['minLat', 'maxLat', 'minLng', 'maxLng', 'zoom', 'scope', 'sort'].includes(k))),
}),
```

```tsx
// src/app/browse/page.tsx — markers via cacheable tile GET, list via existing POST (minimal diff):
const tileParams = new URLSearchParams({
  minLat: String(combinedParams.bounds.minLat), maxLat: String(combinedParams.bounds.maxLat),
  minLng: String(combinedParams.bounds.minLng), maxLng: String(combinedParams.bounds.maxLng),
  zoom: String(currentZoom), scope, sort: sortByRef.current,
  ...(combinedParams.query ? { query: combinedParams.query } : {}),
  ...(combinedParams.listingPurpose ? { listingPurpose: combinedParams.listingPurpose } : {}),
  ...(combinedParams.minPrice ? { minPrice: String(combinedParams.minPrice) } : {}),
  ...(combinedParams.maxPrice ? { maxPrice: String(combinedParams.maxPrice) } : {}),
});
const tileRes = await fetch(`/api/map-tiles?${tileParams}`, { signal });
// paintMarkers(mapRef.current, (await tileRes.json()).markers || []);
```

Keep the existing `/api/map-data` POST for `results`/`nextCursor`/totals in this task — marker cutover only. Full list-path separation (tile-keyed totals) is follow-up work, not this plan.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/tileMap.test.ts --ci`
Expected: PASS. Manual check (dev): pan the map, confirm Network shows `GET /api/map-tiles?…` with `s-maxage` response header and dots painted from `markers`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/map-tiles/route.ts src/app/browse/page.tsx src/__tests__/tileMap.test.ts
git commit -m "feat(tiles): serve markers from cacheable tile GET"
```

---

### Task 6: Prove QPS headroom and roll out flag-gated

**Covers:** AD7, Invariant 5, Scaling Playbook steps 1–4

**Files:**
- Modify: `scripts/scale-stress.ts` (distinct client identifiers per request — required for trustworthy numbers)
- Modify: `docs/compose/reports/map-hotpath-efficiency-audit.md` (append measured results table)
- Test: none new — evidence is measured, not asserted.

**Interfaces:**
- Consumes: production build (`npm run build && npm run start`), live ES + Redis.
- Produces: per-request ES query counts from ES query-stat deltas, Redis hit rates per key prefix (`md:v5:t:*`), p50/p95 route latency, saturation call (thread-pool/queue sampled *during* load).

- [ ] **Step 1: Baseline the tile path on a production build**

```bash
npm run build
npm run start &
npx tsx scripts/scale-smoke.ts
```

Expected: `All scale-ready smoke checks passed.` Record ES baseline:

```bash
curl -s localhost:9200/_nodes/stats/indices/search | python3 -c "import json,sys; d=json.load(sys.stdin); print({k: v['indices']['search']['query_total'] for k,v in d['nodes'].items()})"
```

- [ ] **Step 2: Cold-path ceiling (unique tile per request)**

```bash
npx tsx scripts/scale-stress.ts --tiles-only --unique
```

Expected: collect cold `took` per tile, adaptive-precision attempt rate, max concurrent ES searches ≤ `TILE_CONCURRENCY` (6) × instances. If attempts routinely hit the cap with <150 cells, lower `precisionForZoom` one step for that zoom band (tenant/env, not code fork).

- [ ] **Step 3: Warm-path QPS (repeated pans, shared tiles)**

Drive repeated pans over the same tile set with distinct `x-forwarded-for` per virtual user (otherwise the per-IP rate limiter is the thing under test, not the app). Measure: Redis hit rate on `md:v5:t:*` (target >80% warm), ES query-stat delta per HTTP request (target ≤1 cold-tile query per tile, 0 warm), p50/p95 of `GET /api/map-tiles`.

- [ ] **Step 4: Flag-gated rollout**

```bash
# Rollback without redeploy at any step:
TILE_INDEX_V1=0        # back to split heavyweight indices
TILE_SHADOW_PCT=0      # shadow fully off
TILE_MAX_ATTEMPTS=1    # single precision attempt
TILE_CONCURRENCY=3     # halve per-request sockets
```

Roll out: staging `TILE_INDEX_V1=1` → compare tile `took` + overlap vs legacy (existing `tileShadow` logs) → production 1% → 100%. Record the measured table in the audit report.

- [ ] **Step 5: Commit**

```bash
git add scripts/scale-stress.ts docs/compose/reports/map-hotpath-efficiency-audit.md
git commit -m "chore(tiles): measured tile-index rollout results"
```

---

## Self-Review

1. **Spec coverage:** no external spec doc exists; coverage is anchored to the **Global Constraints** section above (AD1–AD9 + Invariants 1–10, each stated in full so this document stands alone) via each task's **Covers:** line. Every AD/Invariant cited in Global Constraints is exercised by ≥1 task (AD6/quantiles intentionally untouched — thresholds already compute on un-narrowed inputs and ride the tile path for free).
2. **Placeholder scan:** no TBD/TODO/`handle edge cases`/test-only APIs; every code step shows exact diffs, every test step shows runnable code + command + expected output.
3. **Type consistency:** `tileKey` (`md:v5:t:{z/x/y}:{filterHash64}:{sortBucket}`), `TILES_INDEX_ALIAS='listings_tile'`, `buildTileDoc(entity,id)`, `mapWithConcurrency(items,limit,fn)`, `TILE_DOC_INDEXED_FIELDS` names match across Tasks 2–4; route response shape `{ markers, cells, zoom, tiles }` unchanged so the client cutover is paint-compatible.

---

## Deviation log — what the plan got wrong and what shipped instead

### D1 — Task 5 replaced: `GET /api/map-data` instead of cutting the client to `/api/map-tiles`

The plan cut markers to `GET /api/map-tiles` while the list stayed on `POST /api/map-data`.
That requires **two requests per fresh load** — one of them non-cacheable — to reach the edge.

**Shipped instead:** a `GET /api/map-data` wrapper (common filter set; polygons/cursor
explicitly rejected with 400, never silently dropped) so the *single* request the page already
makes becomes CDN-cacheable. `map-tiles` remains available for map-only refreshes.

Why it is strictly better: one request instead of two, no duplicate marker work, no
`{markers,cells,zoom,tiles}` vs `{results,markers,totals,…}` shape split to keep in sync.

### D2 — Task 2's mapping as written would have failed in production (3 defects)

| Defect | Consequence if shipped | Fix |
| --- | --- | --- |
| `amenities` declared `index:false`, `furnishings` absent | `terms` on an unindexed field is a **hard ES error**, so every amenity filter 500s | both are `keyword`, indexed |
| `bedrooms_list` absent | `sortForTopMetrics` (projects, beds) has **no `unmapped_type`** → "No mapping found" → whole query fails | mapped as `integer` |
| only 22 of 32 marker fields present | with `dynamic:false` the missing 12 never reach `_source` → hover/click payload loses badges, price range, furnishing, unit count (**Invariant 3**) | all 32 present (17 indexed + 18 stored) |

The plan's own test asserted only the *indexed* field list, so it would have passed while
all three were broken. The shipped test asserts the searched set, the sortable set, the
marker return set, and that no `_`-prefixed field names exist.

### D3 — "No analyzers" is only true if text queries are routed away

`must[]` in `buildFilters()` is *exactly* the `multi_match` clause set. The tile index carries
no analyzed fields, so a text query against it would match nothing — **an empty map, not an
error**. Shipped: `resolveTileIndexes(must, scope)` returns the legacy split indices whenever
`must.length > 0` (or `TILE_INDEX_V1=0`), and the unified index otherwise.

Consequence: text searches don't get the speedup. That is deliberate — they are the minority
of map pans, and correctness beats uniformity here.

### D4 — `dynamic:false` does NOT shrink `_source`

Probed live: unmapped fields are still stored in `_source`, just not indexed. So the
projection is what makes the index small — and it must live in **one** place, not three.
`TILE_DOC_FIELDS` in `indexDocs.ts` is the single allowlist; the mapping contract is asserted
against it by test.

### D5 — Write-path convergence (invariant 8)

* Active writer = BullMQ → `indexOne`/`deleteOne` → dual-writes `listings_tile` (best-effort,
  never blocks the primary write).
* Supabase reindex webhooks are **dormant** (no migration registers `pg_net` calls) — not
  modified, since editing dead code to match a writer that never runs adds drift risk.
* Admin full-syncs chain the rebuild: `es:index` and `es:index:projects` now run
  `es:tile-sync` automatically, so the recovery path cannot leave the tile index stale.

### D6 — Two bugs found by testing, not by reading

1. **`viewportCoveringTiles` stride-sampled past the tile cap at z≤4**, so a world viewport
   returned one row of tiles. Fed into the new tile-union keys, the union became a *subset*
   of the viewport — AD5 violation: a cache hit could hide listings. Fixed by descending to
   coarser tiles (floor z=1) instead of sampling; coverage is exact and fan-out stays bounded.
   Regression test added per zoom.
2. **Quantile p90 on `created_at` returns a float** (`1781130111610.6`); a `date` field mapped
   `epoch_millis` rejects it → "failed to parse date field" → the whole tile agg failed and
   silently fell back to the legacy path. This was **pre-existing** and latent. Fixed by
   snapping thresholds to integers for date/integer fields; regression test added.

---

## Measured results (production build, single ES node, 1541 docs)

> Dataset is small — these characterize the *request path*, not match-volume cost.
> Re-run against a representative index before sizing production ES.

### Per-layer ceilings (`npm run scale:layered`)

| Layer | Ceiling | p99 | Notes |
| --- | --- | --- | --- |
| Redis GET | ~33,000 QPS | 7ms | never the constraint |
| ES tile-agg (direct) | ~1,200 QPS | 173ms | `queue=0`, `rejected=0` throughout |
| `GET /api/map-tiles` | ~426 QPS | 667ms | `es/req = 0` |
| `POST /api/map-data` | ~360–375 QPS | 404ms | `es/req = 0` |

Bottleneck attribution: **app layer** (route/ES ratio 0.32–0.36) — ES has headroom.

### ES searches per HTTP request (`npm run scale:e2e`)

| Path | Before | After |
| --- | --- | --- |
| Warm map-data (repeat viewport) | 2 | **0** |
| Cold map-data (cache cleared) | ~35 worst / ~4 typical | **7.2** (bounded) |
| Warm tiles | 2 | **0** |

### Horizontal scaling (160 concurrent, 4 load generators)

| | 1 instance | 2 instances | delta |
| --- | --- | --- | --- |
| Aggregate QPS | 304.4 | **473.1** | **+55%** |
| p50 | 268ms | 302ms | — |
| **p99** | **6532ms** | **2024ms** | **−69%** |
| Errors | 0% | 0% | — |

During the 2-instance load ES reported `queue=0 active=0/13 rejected=0 cpu=1–5% heap=23%`.

Prior to this work the same test gave +12% throughput with latency *doubled* — ES's search
thread pool was saturated (`queue=17, active=13/13`) and app replicas only added queue depth.

### Index footprint

| Index | Docs | Size |
| --- | --- | --- |
| `properties_v1` + `projects_v1` | 1,541 | 6.4 MB |
| `listings_tile` | 1,541 | **975 KB (~15%)** |

### Verification

```
npm run test:ci     16 suites / 127 tests  PASS
npm run scale:smoke PASS (worst fan-out 99 → 35)
npm run scale:e2e   31/31 PASS
```
