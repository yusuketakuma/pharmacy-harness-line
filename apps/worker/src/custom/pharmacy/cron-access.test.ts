import { describe, expect, it, vi } from 'vitest';

const pharmacyMode = vi.hoisted(() => vi.fn());
vi.mock('./growth-loop/access.js', () => ({ isPharmacyModeAccount: pharmacyMode }));

import { shouldRunGenericCron } from './cron-access.js';

describe('shouldRunGenericCron', () => {
  it('fails closed without an active tenant account', async () => {
    await expect(shouldRunGenericCron({} as D1Database, [])).resolves.toBe(false);
  });

  it('disables generic jobs when any active account is a pharmacy', async () => {
    pharmacyMode.mockImplementation(async (_db: D1Database, id: string) => id === 'pharmacy-a');
    await expect(
      shouldRunGenericCron({} as D1Database, ['generic-a', 'pharmacy-a']),
    ).resolves.toBe(false);
  });

  it('keeps generic jobs for an all-generic installation', async () => {
    pharmacyMode.mockResolvedValue(false);
    await expect(
      shouldRunGenericCron({} as D1Database, ['generic-a']),
    ).resolves.toBe(true);
  });
});
