import { describe, expect, it } from 'vitest';
import { canAccessPharmacyAccount, isPharmacyModeAccount } from './access.js';

function db(rows: { account?: boolean; assigned?: boolean }): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes('FROM line_accounts')) return rows.account ? { id: 'account-a' } : null;
              if (sql.includes('FROM pharmacy_staff_accounts')) return rows.assigned ? { ok: 1 } : null;
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('pharmacy staff account access', () => {
  it('does not grant every pharmacy account to an unassigned owner role', async () => {
    await expect(canAccessPharmacyAccount(
      db({ account: true, assigned: false }),
      { id: 'owner-a', role: 'owner' },
      'account-a',
    )).resolves.toBe(false);
  });

  it('allows an explicitly assigned active staff identity', async () => {
    await expect(canAccessPharmacyAccount(
      db({ account: true, assigned: true }),
      { id: 'staff-a', role: 'staff' },
      'account-a',
    )).resolves.toBe(true);
  });

  it('keeps the environment owner as the explicit installation-wide authority', async () => {
    await expect(canAccessPharmacyAccount(
      db({ account: true, assigned: false }),
      { id: 'env-owner', role: 'owner' },
      'account-a',
    )).resolves.toBe(true);
  });
});

describe('pharmacy account mode', () => {
  it('is enabled only by an explicit pharmacy capability row', async () => {
    const pharmacyDb = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ mode: 'pharmacy' }) }),
      }),
    } as unknown as D1Database;
    const genericDb = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;

    await expect(isPharmacyModeAccount(pharmacyDb, 'account-a')).resolves.toBe(true);
    await expect(isPharmacyModeAccount(genericDb, 'account-a')).resolves.toBe(false);
    await expect(isPharmacyModeAccount(pharmacyDb, null)).resolves.toBe(false);
  });
});
