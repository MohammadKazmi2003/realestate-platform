import fs from 'fs';
import path from 'path';
import { TILES_INDEX_ALIAS } from '@/lib/elasticsearch';

// The tile index is only safe to serve from if (a) every field buildFilters()
// can SEARCH is actually indexed, and (b) every field TILE_TOP_METRICS_FIELDS
// RETURNS is actually present. Both failures are silent in unit tests and loud
// in production: a terms filter on an index:false field is a hard ES error, and
// a missing _source field breaks the fetch-free hover/click contract (Inv. 3).

const templatePath = path.join(process.cwd(), 'es-config', 'listings-tile-template.json');

function loadProps(): Record<string, any> {
  const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  return tpl.template.mappings.properties;
}

// Mirrors buildFilters() in esQueryBuilder.ts — the single filtered population.
const SEARCHED_TERMS = ['status', 'entity_type', 'property_type', 'bhk_type', 'listing_purpose', 'amenities', 'furnishings'];
const SEARCHED_RANGES = ['bedrooms', 'bathrooms', 'area_sqft'];
const SEARCHED_SORTS = ['sort_price', 'price', 'low_price', 'created_at', 'bedrooms', 'bathrooms', 'area_sqft', 'bedrooms_list'];
const GEO = ['location'];

describe('lightweight tile index contract', () => {
  it('alias is listings_tile', () => {
    expect(TILES_INDEX_ALIAS).toBe('listings_tile');
  });

  it('template file parses and is a valid index template shape', () => {
    const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    expect(tpl.index_patterns).toEqual(['listings_tile*']);
    expect(tpl.template.mappings.dynamic).toBe(false);
    expect(tpl.template.settings.number_of_shards).toBe(1);
  });

  it('no field name starts with underscore (ES rejects metadata-prefixed props)', () => {
    const props = loadProps();
    expect(Object.keys(props).filter((k) => k.startsWith('_'))).toEqual([]);
  });

  it.each([...SEARCHED_TERMS, ...SEARCHED_RANGES])(
    'searchable field %s is indexed (index:false would hard-error the query)',
    (f) => {
      const props = loadProps();
      expect(props[f]).toBeDefined();
      expect(props[f].index).not.toBe(false);
    }
  );

  it.each([...new Set(SEARCHED_SORTS)])('sortable field %s has doc values', (f) => {
    const props = loadProps();
    expect(props[f]).toBeDefined();
    // index:false is allowed for sort-only numerics IF doc_values stay on.
    expect(props[f].doc_values).not.toBe(false);
  });

  it('geo filter field is geo_point', () => {
    const props = loadProps();
    for (const g of GEO) expect(props[g].type).toBe('geo_point');
  });

  it('every field TILE_TOP_METRICS_FIELDS returns is present (fetch-free contract)', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'esTileMarkers.ts'), 'utf8');
    const block = src.match(/const TILE_TOP_METRICS_FIELDS = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const fields = block![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(fields.length).toBeGreaterThan(25);
    const props = loadProps();
    const missing = fields.filter((f) => !(f in props));
    expect(missing).toEqual([]);
  });

  it('carries no analyzers or completion suggester (the cost this index removes)', () => {
    // Assert on settings+mappings only — _meta holds explanatory prose that
    // deliberately mentions those words.
    const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const structural = JSON.stringify({ settings: tpl.template.settings, mappings: { ...tpl.template.mappings, _meta: undefined } });
    expect(structural).not.toMatch(/analyzer|completion|edge_ngram|synonym/);
    expect(structural).not.toMatch(/"suggest"/);
  });

  it('project_name and unit_count are absent: markers no longer read them, and the by_project agg runs on legacy indices only', () => {
    const props = loadProps();
    // Carrying them would only add fetch bytes to every top_hits — nothing in
    // the marker path consumes either field (verified against the frontend).
    expect(props.project_name).toBeUndefined();
    expect(props.unit_count).toBeUndefined();
  });

  it('properties template keeps only the subfields the code actually queries', () => {
    // Dead subfields (title.autocomplete, project_name.autocomplete, suggest,
    // *.keyword except project_name) were costing edge-ngram terms, FST heap
    // and index bytes on every write for queries that never ran.
    const tpl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'es-config', 'index-template.json'), 'utf8'));
    const pr = tpl.template.mappings.properties;
    const subs = Object.entries(pr)
      .flatMap(([k, v]: [string, any]) => Object.keys(v.fields || {}).map((f) => `${k}.${f}`))
      .sort();
    expect(subs).toEqual(['location_text.autocomplete', 'project_name.keyword']);
    expect(pr.suggest).toBeUndefined();

    const ptpl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'es-config', 'projects-index-template.json'), 'utf8'));
    const pp = ptpl.template.mappings.properties;
    const psubs = Object.entries(pp)
      .flatMap(([k, v]: [string, any]) => Object.keys(v.fields || {}).map((f) => `${k}.${f}`))
      .sort();
    expect(psubs).toEqual([]); // projects query only the root fields + suggest
    expect(pp.suggest).toBeDefined(); // projects/autocomplete genuinely uses it
  });
});
