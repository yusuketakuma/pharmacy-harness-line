import { describe, expect, it, vi } from 'vitest';
import { pinnedAccountId, requireConfirmation } from '../src/custom/pharmacy/rich-menu/guard.js';

describe('pharmacy rich-menu MCP guard', () => {
  it('pins every operation to the configured account', () => {
    vi.stubEnv('LINE_HARNESS_ACCOUNT_ID', 'account-a');
    expect(pinnedAccountId()).toBe('account-a');
    expect(pinnedAccountId('account-a')).toBe('account-a');
    expect(() => pinnedAccountId('account-b')).toThrow(/does not match/i);
  });

  it('requires explicit confirmation for live mutations', () => {
    expect(() => requireConfirmation(false, false, 'publish')).toThrow(/dryRun=false.*confirm=true/i);
    expect(() => requireConfirmation(false, true, 'publish')).not.toThrow();
    expect(() => requireConfirmation(true, false, 'publish')).not.toThrow();
  });
});
