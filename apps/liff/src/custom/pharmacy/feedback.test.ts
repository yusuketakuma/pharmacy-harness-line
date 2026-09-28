import { describe, expect, it } from 'vitest';
import { nextAutoRetryDelay } from './feedback.js';

// V036-12: the auto-retry budget is fixed (two attempts: 3s then 6s). The hook
// consumes an attempt only when its timer fires, so the delay table is the
// whole policy — keep it pinned here.
describe('nextAutoRetryDelay', () => {
  it('backs off 3s then 6s across the two allowed attempts', () => {
    expect(nextAutoRetryDelay(0)).toBe(3000);
    expect(nextAutoRetryDelay(1)).toBe(6000);
  });

  it('stops retrying once the budget is spent', () => {
    expect(nextAutoRetryDelay(2)).toBeNull();
    expect(nextAutoRetryDelay(3)).toBeNull();
  });
});
