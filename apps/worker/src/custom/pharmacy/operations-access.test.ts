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

  it('allows an authenticated system owner to operate an active account', async () => {
    await expect(canAccessPharmacyOperationsAccount(
      db([{ channel_id: 'channel-a' }]),
      { id: 'owner-1', role: 'owner' },
      'account-a',
    )).resolves.toBe(true);
  });

  it('fails closed when the assignment lookup is unavailable', async () => {
    let query = 0;
    const unavailable = {
      prepare: vi.fn(() => ({
        bind: () => ({
          first: async () => {
            if (query++ === 0) return { channel_id: 'channel-a' };
            throw new Error('database unavailable');
          },
        }),
      })),
    } as unknown as D1Database;
    await expect(canAccessPharmacyOperationsAccount(
      unavailable,
      { id: 'staff-a', role: 'admin' },
      'account-a',
    )).resolves.toBe(false);
  });
});
