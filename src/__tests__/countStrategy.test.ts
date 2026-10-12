import { buildCountCacheKey, buildCountQuery, buildFilters, buildListQuery, parseListingCounts } from '@/lib/esQueryBuilder';

// The counting strategy is a measured decision (100k/1M corpora):
// - split counts (default): the size:24 list query never counts; exact totals
//   come from a cached size:0 request (Lucene's sub-linear Weight.count path),
//   keyed by the filter population only so pages/sorts reuse it;
// - inline native fallback (SPLIT_COUNTS=0): track_total_hits:true + terms;
// - counter/capped legacy fallbacks for AD7 revert.
// These tests pin the shapes so a slower or less-reusable path cannot silently
// return.
describe('list counting strategy', () => {
  const params = {
    bounds: { minLat: 28.3, maxLat: 28.7, minLng: 76.9, maxLng: 77.3 },
    scope: 'both',
    sort: 'newest',
    pageSize: 24,
  };

  beforeEach(() => {
    delete process.env.SPLIT_COUNTS;
    delete process.env.NATIVE_COUNTS;
    delete process.env.EXACT_COUNT_COUNTERS;
  });

  it('split (default): list query never counts, no count aggs', () => {
    const q: any = buildListQuery(params);
    expect(q.track_total_hits).toBe(false);
    expect(q.aggs.by_entity_type).toBeUndefined();
    expect(q.aggs.exact_total).toBeUndefined();
    expect(q.aggs.exact_property).toBeUndefined();
  });

  it('split: single scope list query has no count aggs either', () => {
    const q: any = buildListQuery({ ...params, scope: 'properties' });
    expect(q.track_total_hits).toBe(false);
    expect(q.aggs.by_entity_type).toBeUndefined();
    expect(q.aggs.exact_total).toBeUndefined();
  });

  it('SPLIT_COUNTS=0 restores inline native counting (tth + entity terms)', () => {
    process.env.SPLIT_COUNTS = '0';
    const q: any = buildListQuery(params);
    expect(q.track_total_hits).toBe(true);
    expect(q.aggs.by_entity_type).toEqual({ terms: { field: 'entity_type', size: 5 } });
    expect(q.aggs.exact_total).toBeUndefined();
  });

  it('SPLIT_COUNTS=0 NATIVE_COUNTS=0 restores the counter fallback', () => {
    process.env.SPLIT_COUNTS = '0';
    process.env.NATIVE_COUNTS = '0';
    const q: any = buildListQuery(params);
    expect(q.track_total_hits).toBe(false);
    expect(q.aggs.exact_total).toBeDefined();
    expect(q.aggs.exact_property).toBeDefined();
    expect(q.aggs.exact_project).toBeDefined();
    expect(q.aggs.by_entity_type).toBeUndefined();
  });

  it('SPLIT_COUNTS=0 NATIVE_COUNTS=0 EXACT_COUNT_COUNTERS=0 falls back to capped counting', () => {
    process.env.SPLIT_COUNTS = '0';
    process.env.NATIVE_COUNTS = '0';
    process.env.EXACT_COUNT_COUNTERS = '0';
    const q: any = buildListQuery(params);
    expect(q.track_total_hits).toBe(10000);
    expect(q.aggs.by_entity_type).toBeDefined();
    expect(q.aggs.exact_total).toBeUndefined();
  });

  it('pagination still travels as search_after and sort keeps the id tiebreaker', () => {
    const cursor = ['2026-01-01T00:00:00.000Z', 'abc'];
    const q: any = buildListQuery({ ...params, cursor });
    expect(q.search_after).toEqual(cursor);
    expect(q.sort[q.sort.length - 1]).toEqual({ id: { order: 'asc' } });
  });

  it('count query is size:0, exact, entity-split only for scope=both, request-cached', () => {
    const both: any = buildCountQuery([], [{ term: { status: 'available' } }], 'both');
    expect(both.size).toBe(0);
    expect(both.track_total_hits).toBe(true);
    expect(both.aggs.by_entity_type).toEqual({ terms: { field: 'entity_type', size: 2 } });
    expect(both.request_cache).toBe(true);

    const props: any = buildCountQuery([], [{ term: { status: 'available' } }], 'properties');
    expect(props.size).toBe(0);
    expect(props.track_total_hits).toBe(true);
    expect(props.aggs).toBeUndefined();
  });

  it('parses exact totals and the property/project split', () => {
    const both = parseListingCounts(
      { hits: { total: { value: 42, relation: 'eq' } }, aggregations: { by_entity_type: { buckets: [
        { key: 'property', doc_count: 30 }, { key: 'project', doc_count: 12 },
      ] } } },
      'both'
    );
    expect(both).toEqual({ total: 42, totalRelation: 'eq', propertyTotal: 30, projectTotal: 12 });

    const props = parseListingCounts({ hits: { total: { value: 7, relation: 'eq' } } }, 'properties');
    expect(props).toEqual({ total: 7, totalRelation: 'eq', propertyTotal: 7, projectTotal: 0 });

    const projs = parseListingCounts({ hits: { total: { value: 5, relation: 'eq' } } }, 'projects');
    expect(projs).toEqual({ total: 5, totalRelation: 'eq', propertyTotal: 0, projectTotal: 5 });
  });

  it('count cache key is page/sort-invariant (the reuse contract)', () => {
    const base = buildFilters({ ...params, sort: 'newest' }, 'both');
    const sorted = buildFilters({ ...params, sort: 'price_asc' }, 'both');
    // sort is not part of the population, so the same filters must key the same.
    expect(buildCountCacheKey(base.must, base.filters)).toBe(buildCountCacheKey(sorted.must, sorted.filters));

    const filtered = buildFilters({ ...params, maxPrice: 20000000 }, 'both');
    expect(buildCountCacheKey(filtered.must, filtered.filters)).not.toBe(buildCountCacheKey(base.must, base.filters));

    // Same population, different scope => different key (entity_type filter differs).
    const propsScope = buildFilters({ ...params, scope: 'properties' }, 'properties');
    expect(buildCountCacheKey(propsScope.must, propsScope.filters)).not.toBe(buildCountCacheKey(base.must, base.filters));
  });
});
