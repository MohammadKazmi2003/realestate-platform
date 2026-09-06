import { mergeUniqueById } from '@/lib/collections';

describe('mergeUniqueById — infinite-scroll key safety', () => {
  it('appends fresh ids', () => {
    expect(mergeUniqueById([{ id: 'a' }], [{ id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('drops ids already present (overlapping search_after pages)', () => {
    expect(mergeUniqueById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  it('drops a fully duplicated page (sentinel double-fire)', () => {
    const page = [{ id: 'a' }, { id: 'b' }];
    expect(mergeUniqueById(page, page)).toEqual(page);
  });

  it('handles empty sides without copying unnecessarily', () => {
    expect(mergeUniqueById([], [{ id: 'a' }])).toEqual([{ id: 'a' }]);
    const prev = [{ id: 'a' }];
    expect(mergeUniqueById(prev, [])).toBe(prev);
  });
});
