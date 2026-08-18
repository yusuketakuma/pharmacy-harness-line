import { describe, expect, it } from 'vitest';
import {
  canAccessPharmacyAccount,
  hasPharmacyCapability,
  hasPharmacyModeAccount,
  isPharmacyTenant,
  isPharmacyModeAccount,
  resolveAccessiblePharmacyTenant,
} from './access.js';

function db(rows: { tenantId?: string; assigned?: boolean; accountAssigned?: boolean }): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes('pharmacy_staff_accounts')) {
                return rows.accountAssigned ? { tenant_id: rows.tenantId } : null;
              }
              if (sql.includes('FROM line_accounts')) {
                return rows.tenantId ? { tenant_id: rows.tenantId } : null;
              }
              if (sql.includes('FROM tenant_staff_memberships')) {
                return rows.assigned ? { ok: 1 } : null;
              }
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
      db({ tenantId: 'tenant-a', assigned: false }),
      { id: 'owner-a', role: 'owner' },
      'account-a',
    )).resolves.toBe(false);
  });

  it('allows a staff identity assigned to the account tenant', async () => {
    await expect(resolveAccessiblePharmacyTenant(
      db({ tenantId: 'tenant-a', assigned: true, accountAssigned: true }),
      { id: 'staff-a', role: 'staff' },
      'account-a',
    )).resolves.toBe('tenant-a');
  });

  it('rejects a staff member with only tenant membership and no account assignment', async () => {
    await expect(resolveAccessiblePharmacyTenant(
      db({ tenantId: 'tenant-a', assigned: true, accountAssigned: false }),
      { id: 'staff-a', role: 'staff' },
      'account-a',
    )).resolves.toBeNull();
  });

  it('does not grant the legacy environment owner cross-tenant pharmacy access', async () => {
    await expect(resolveAccessiblePharmacyTenant(
      db({ tenantId: 'tenant-a', assigned: false }),
      { id: 'env-owner', role: 'owner' },
      'account-a',
    )).resolves.toBeNull();
  });

  it('fails closed for an account without an active tenant mapping', async () => {
    await expect(resolveAccessiblePharmacyTenant(
      db({ assigned: true }),
      { id: 'staff-a', role: 'staff' },
      'account-a',
    )).resolves.toBeNull();
  });

  it('resolves the active tenant mapping and assignment in one authorization query', async () => {
    const sql: string[] = [];
    const joinedDb = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind: () => ({
            first: async () => ({ tenant_id: 'tenant-a' }),
          }),
        };
      },
    } as unknown as D1Database;

    await expect(resolveAccessiblePharmacyTenant(
      joinedDb,
      { id: 'staff-a', role: 'staff' },
      'account-a',
    )).resolves.toBe('tenant-a');
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('pharmacy_staff_accounts');
    expect(sql[0]).toContain('tenant_line_accounts');
    expect(sql[0]).toContain('tenant_staff_memberships');
  });
});

describe('pharmacy account mode', () => {
  it('treats a mapped account as pharmacy mode', async () => {
    const pharmacyDb = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () => sql.includes('pharmacy_account_capabilities')
          ? { mode: 'pharmacy' }
          : { pharmacy_install: 1 } }),
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

  it('keeps an account generic when its capability row is absent', async () => {
    const mappedButIncomplete = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () => sql.includes('pharmacy_account_capabilities')
          ? null
          : { pharmacy_install: 1 } }),
      }),
    } as unknown as D1Database;
    await expect(isPharmacyModeAccount(mappedButIncomplete, 'account-a')).resolves.toBe(false);
  });

  it('fails closed when the capability table exists but the account row is missing', async () => {
    const deployedButIncomplete = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () => {
          if (sql.includes('sqlite_master')) return { name: 'pharmacy_account_capabilities' };
          if (sql.includes('pharmacy_account_capabilities')) return null;
          return null;
        } }),
      }),
    } as unknown as D1Database;
    await expect(isPharmacyModeAccount(deployedButIncomplete, 'account-a')).resolves.toBe(true);
    await expect(isPharmacyTenant(deployedButIncomplete, 'tenant-a')).resolves.toBe(true);
    await expect(hasPharmacyModeAccount(deployedButIncomplete)).resolves.toBe(true);
  });

  it('fails closed when the capability table is not deployed yet', async () => {
    const partialMigrationDb = {
      prepare: (sql: string) => ({
        bind: () => ({ first: async () => {
          if (sql.includes('pharmacy_account_capabilities')) throw new Error('no such table');
          return { pharmacy_install: 1 };
        } }),
      }),
    } as unknown as D1Database;
    await expect(isPharmacyModeAccount(partialMigrationDb, 'account-a')).resolves.toBe(true);
  });

  it('fails closed when the mode classifier cannot read D1', async () => {
    const unavailable = {
      prepare: () => { throw new Error('D1 unavailable'); },
    } as unknown as D1Database;
    await expect(isPharmacyModeAccount(unavailable, 'account-a')).resolves.toBe(true);
    await expect(isPharmacyTenant(unavailable, 'tenant-a')).resolves.toBe(true);
    await expect(hasPharmacyModeAccount(unavailable)).resolves.toBe(true);
    await expect(hasPharmacyCapability(unavailable, 'account-a', 'prescription_intake')).resolves.toBe(false);
  });
});
