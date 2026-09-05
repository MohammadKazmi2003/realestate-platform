import {
  validateEnqueueInput,
  diffIdSets,
  upsertJobId,
  deleteJobId,
} from '@/lib/searchIndex';

// Hermetic: only validation/diff logic under test — keep the ES/Redis
// clients (undici streams, ioredis sockets) out of the jsdom env.
jest.mock('@/lib/elasticsearch', () => ({
  ES_INDEX_ALIAS: 'properties_search',
  PROJECTS_INDEX_ALIAS: 'projects_search',
  getElasticsearchClient: jest.fn(),
}));
jest.mock('@/lib/indexDocs', () => ({
  indexOne: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock('@/lib/redis', () => ({
  cacheDelete: jest.fn(),
}));

describe('searchIndex — incremental contract', () => {
  it('accepts valid enqueue payloads, defaulting op to upsert', () => {
    expect(validateEnqueueInput({ entity: 'property', id: 'abc' })).toEqual({
      entity: 'property',
      id: 'abc',
      op: 'upsert',
    });
    expect(validateEnqueueInput({ entity: 'project', id: 'x', op: 'delete' })).toEqual({
      entity: 'project',
      id: 'x',
      op: 'delete',
    });
  });

  it('rejects bad entity/id/op', () => {
    expect(() => validateEnqueueInput({ entity: 'lead', id: 'x' })).toThrow();
    expect(() => validateEnqueueInput({ entity: 'property', id: '' })).toThrow();
    expect(() => validateEnqueueInput({ entity: 'property', id: 'x', op: 'reindex-all' })).toThrow();
  });

  it('uses distinct job ids per op so deletes never collapse into upserts', () => {
    expect(upsertJobId('property', 'id1')).not.toBe(deleteJobId('property', 'id1'));
    expect(upsertJobId('property', 'id1')).toBe('si-property-id1-upsert');
    // BullMQ rejects custom ids containing ':' — keep separators compatible.
    expect(upsertJobId('property', '550e8400-e29b-41d4-a716-446655440000')).not.toContain(':');
    expect(deleteJobId('project', '550e8400-e29b-41d4-a716-446655440000')).not.toContain(':');
  });

  it('diffs PG vs ES id sets both ways', () => {
    const { missingInEs, orphanInEs } = diffIdSets(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(missingInEs).toEqual(['a']);
    expect(orphanInEs).toEqual(['d']);
  });

  it('empty diff when in sync', () => {
    expect(diffIdSets(['a'], ['a'])).toEqual({ missingInEs: [], orphanInEs: [] });
  });
});
