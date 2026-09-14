import { tileGalleryComplete, tileStringArray, tileNumberArray } from '@/lib/tileGallery';

describe('tileGalleryComplete — click-fetch skip decision', () => {
  it('skips the fetch for single-photo and photo-less tiles', () => {
    expect(tileGalleryComplete(1)).toBe(true);
    expect(tileGalleryComplete(0)).toBe(true);
  });

  it('fetches for multi-photo tiles and unknown counts', () => {
    expect(tileGalleryComplete(2)).toBe(false);
    expect(tileGalleryComplete(20)).toBe(false);
    expect(tileGalleryComplete(null)).toBe(false);
    expect(tileGalleryComplete(undefined)).toBe(false);
  });
});

describe('tile array normalization — MapLibre stringifies array props', () => {
  it('passes real arrays through', () => {
    expect(tileStringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(tileNumberArray([1, 2])).toEqual([1, 2]);
  });

  it('parses JSON-stringified arrays back', () => {
    expect(tileStringArray('["a","b"]')).toEqual(['a', 'b']);
    expect(tileNumberArray('[1,2]')).toEqual([1, 2]);
  });

  it('falls back to [] for nulls, junk, and non-arrays', () => {
    expect(tileStringArray(null)).toEqual([]);
    expect(tileStringArray('nope')).toEqual([]);
    expect(tileStringArray('{"a":1}')).toEqual([]);
    expect(tileNumberArray(undefined)).toEqual([]);
    expect(tileNumberArray('[1,"x"]')).toEqual([1]);
  });
});
