import { describe, expect, it, vi } from 'vitest';
import { canAccessPharmacyOperationsAccount } from './operations-access.js';

function db(rows: unknown[]): D1Database {
  const queue = [...rows];
  return {
    prepare: vi.fn(() => ({
      bind: () => ({ first: async () => queue.shift() ?? null }),
    })),
  } as unknown as D1Database;
}

describe('pharmacy operations account access', () => {
  it('binds the environment owner to its configured LINE channel', async () => {
    await expect(canAccessPharmacyOperationsAccount(
      db([{ channel_id: 'channel-b' }]),
      { id: 'env-owner', role: 'owner' },
      'account-b',
      'channel-a',
    )).resolves.toBe(false);
  });

  it('requires an active account assignment for regular staff', async () => {
    await expect(canAccessPharmacyOperationsAccount(
      db([{ channel_id: 'channel-a' }, { ok: 1 }]),
      { id: 'staff-a', role: 'admin' },
      'account-a',
    )).resolves.toBe(true);
    await expect(canAccessPharmacyOperationsAccount(
      db([{ channel_id: 'channel-b' }, null]),
      { id: 'staff-a', role: 'admin' },
      'account-b',
    )).resolves.toBe(false);
  });
});
