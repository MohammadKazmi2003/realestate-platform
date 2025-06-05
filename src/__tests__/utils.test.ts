// src/__tests__/utils.test.ts
import { cn } from '@/lib/utils';

describe('cn utility function', () => {
  it('should correctly combine multiple class names', () => {
    expect(cn('class1', 'class2', 'class3')).toBe('class1 class2 class3');
  });

  it('should filter out falsy values', () => {
    expect(cn('active', null, 'px-4', undefined, false, '', 'py-2')).toBe('active px-4 py-2');
  });

  it('should return an empty string if no valid class names are provided', () => {
    expect(cn(null, undefined, false, '')).toBe('');
  });
});