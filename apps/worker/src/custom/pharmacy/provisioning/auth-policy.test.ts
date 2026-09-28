import { describe, expect, it } from 'vitest';
import { sessionPolicy } from './auth-policy.js';

describe('approved administrator session policy', () => {
  it('uses the approved absolute and idle limits', () => {
    expect(sessionPolicy('bootstrap')).toEqual({
      absoluteMs: 30 * 60_000,
      idleMs: 10 * 60_000,
    });
    expect(sessionPolicy('standard')).toEqual({
      absoluteMs: 8 * 60 * 60_000,
      idleMs: 15 * 60_000,
    });
  });
});
