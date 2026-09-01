import { describe, expect, it } from 'vitest';
import { normalizeLoginId } from './auth-throttle.js';

describe('durable administrator login throttle', () => {
  it('normalizes equivalent login IDs to one durable account key', () => {
    expect(normalizeLoginId('  ＡＤＭＩＮ  ')).toBe('admin');
    expect(normalizeLoginId('Owner.User')).toBe('owner.user');
  });
});
