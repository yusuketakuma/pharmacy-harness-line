import { describe, expect, test } from 'vitest';
import { clampLimitOffset } from './pagination.js';

describe('clampLimitOffset', () => {
  test('defaults and clamps', () => {
    expect(clampLimitOffset(undefined, undefined, 50)).toEqual({ limit: 50, offset: 0 });
    expect(clampLimitOffset('9999', '10', 50)).toEqual({ limit: 200, offset: 10 });
  });
  test.each(['abc', '0', '-1', '1.5', ''])('rejects limit=%s', (v) => {
    expect(clampLimitOffset(v, undefined, 50)).toBeNull();
  });
  test('rejects negative / non-integer offset', () => {
    expect(clampLimitOffset('10', '-1', 50)).toBeNull();
    expect(clampLimitOffset('10', 'x', 50)).toBeNull();
  });
});
