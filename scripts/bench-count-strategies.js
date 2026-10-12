#!/usr/bin/env node
/**
 * Counting-strategy benchmark for the list query (scope=both).
 *
 * Usage:
 *   node scripts/bench-count-strategies.js [indexes] [n]
 *   INDEXES=properties_search,projects_search node scripts/bench-count-strategies.js
 *
 * Compares, for the same filters and the same page-1 query shape:
 *   S1  filter→value_count counters x3   (pre-NATIVE_COUNTS implementation)
 *   S3  filter aggs x2 (doc_count, total = sum)
 *   S4  track_total_hits:true only       (total, no entity split)
 *   S5  track_total_hits:true + by_entity_type terms   ← shipped strategy
 *   S6  by_entity_type terms only (total = sum)
 *   S8  track_total_hits:true + keyed filters agg
 *
 * Filter-cache state is equalised before every strategy (clear + prime), so a
 * later strategy cannot inherit the filter bitsets warmed by an earlier one.
 * Counts are compared across strategies; mismatches are reported.
 */
const ES = process.env.ES_URL || 'http://localhost:9200';
const INDEXES = process.argv[2] || process.env.INDEXES || 'properties_search,projects_search';
const N = Number(process.argv[3] || process.env.N || 15);

const ALL = { minLat: -60, maxLat: 70, minLng: -170, maxLng: 170 };
const box = (b) => ({ top_left: { lat: b.maxLat, lon: b.minLng }, bottom_right: { lat: b.minLat, lon: b.maxLng } });
const SRC = ['id', 'entity_type', 'location', 'price', 'sort_price', 'low_price', 'title', 'image_url', 'created_at'];

async function es(path, body) {
  const r = await fetch(ES + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function clearQueryCache() {
  await fetch(`${ES}/${INDEXES}/_cache/clear?query=true`, { method: 'POST' });
}

function strategies(filters) {
  const base = { bool: { must: [{ match_all: {} }], filter: filters } };
  const scoped = (extra) => ({ filter: { bool: { must: [{ match_all: {} }], filter: [...filters, extra] } } });
  const vc = (extra) => ({ ...scoped(extra), aggs: { total: { value_count: { field: 'id' } } } });
  const common = { size: 24, sort: [{ created_at: { order: 'desc' } }, { id: { order: 'asc' } }], _source: SRC };
  return {
    S1_counters3: { ...common, track_total_hits: false, query: base, aggs: {
      exact_total: { filter: base, aggs: { total: { value_count: { field: 'id' } } } },
      exact_property: vc({ term: { entity_type: 'property' } }),
      exact_project: vc({ term: { entity_type: 'project' } }),
    } },
    S3_filters2: { ...common, track_total_hits: false, query: base, aggs: {
      exact_property: scoped({ term: { entity_type: 'property' } }),
      exact_project: scoped({ term: { entity_type: 'project' } }),
    } },
    S4_tth_true: { ...common, track_total_hits: true, query: base },
    S5_tth_terms: { ...common, track_total_hits: true, query: base, aggs: {
      by_entity_type: { terms: { field: 'entity_type', size: 2 } },
    } },
    S6_terms: { ...common, track_total_hits: false, query: base, aggs: {
      by_entity_type: { terms: { field: 'entity_type', size: 2 } },
    } },
    S8_tth_filters: { ...common, track_total_hits: true, query: base, aggs: {
      by_entity_type: { filters: { filters: {
        property: { term: { entity_type: 'property' } },
        project: { term: { entity_type: 'project' } },
      } } },
    } },
  };
}

function extract(name, res) {
  const h = res.hits.total;
  const total = typeof h === 'object' ? h.value : h;
  const rel = typeof h === 'object' ? h.relation : undefined;
  const a = res.aggregations || {};
  let property = 0; let project = 0; let t = total;
  if (name.startsWith('S1') || name.startsWith('S3')) {
    property = a.exact_property?.doc_count ?? a.exact_property?.total?.value ?? 0;
    project = a.exact_project?.doc_count ?? a.exact_project?.total?.value ?? 0;
    t = name.startsWith('S1') ? (a.exact_total?.total?.value ?? property + project) : property + project;
  } else if (name.startsWith('S5') || name.startsWith('S6')) {
    for (const b of a.by_entity_type?.buckets || []) {
      if (b.key === 'property') property = b.doc_count;
      if (b.key === 'project') project = b.doc_count;
    }
    if (name.startsWith('S6')) t = property + project;
  } else if (name.startsWith('S8')) {
    property = a.by_entity_type?.buckets?.property?.doc_count ?? 0;
    project = a.by_entity_type?.buckets?.project?.doc_count ?? 0;
  }
  return { total: t, relation: rel, property, project };
}

async function medianTook(body, filters) {
  await clearQueryCache();
  await es(`/${INDEXES}/_search`, { size: 0, track_total_hits: false, query: { bool: { must: [{ match_all: {} }], filter: filters } } });
  const toks = []; let last = null;
  for (let i = 0; i < N; i++) { const res = await es(`/${INDEXES}/_search`, body); toks.push(res.took); last = res; }
  toks.sort((a, b) => a - b);
  return { took: toks[Math.floor(toks.length / 2)], min: toks[0], max: toks[toks.length - 1], res: last };
}

async function main() {
  const scenarios = [
    { name: 'ALL docs', filters: [{ term: { status: 'available' } }, { geo_bounding_box: { location: box(ALL) } }] },
    { name: 'narrow bbox', filters: [{ term: { status: 'available' } }, { geo_bounding_box: { location: box({ minLat: 24.7, maxLat: 25.4, minLng: 54.9, maxLng: 55.5 }) } }] },
    { name: 'type term', filters: [{ term: { status: 'available' } }, { term: { property_type: 'Land / Plot' } }] },
  ];
  console.log(`=== counting strategies  ES=${ES}  indexes=${INDEXES}  n=${N} ===\n`);
  for (const sc of scenarios) {
    const strat = strategies(sc.filters);
    console.log(`--- ${sc.name} ---`);
    let ref = null;
    for (const [name, body] of Object.entries(strat)) {
      const { took, min, max, res } = await medianTook(body, sc.filters);
      const c = extract(name, res);
      if (!ref) ref = c;
      const match = c.total === ref.total && c.property === ref.property && c.project === ref.project;
      const split = name.startsWith('S4') ? ' (no split by design)' : match ? '' : ' COUNTS-MISMATCH';
      console.log(`${name.padEnd(16)} took=${String(took).padStart(5)}ms (min ${min} max ${max}) total=${c.total} prop=${c.property} proj=${c.project}${split}`);
    }
    console.log('');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
