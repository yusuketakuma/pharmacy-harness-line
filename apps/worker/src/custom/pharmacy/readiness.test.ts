import { describe, expect, it } from 'vitest';
import { getPharmacyReadiness } from './readiness.js';

describe('canonical pharmacy readiness projection', () => {
  it('keeps external endpoint evidence unverified and returns boolean operational readiness only', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
        calls.push({ sql, values });
        return {
          id: 'account-a', capabilities_json: JSON.stringify(['electronic_prescription', 'emergency_contraception']),
          endpoint_configured: 1, endpoint_checked_at: '2026-08-20T00:00:00.000Z',
          emergency_requirements_complete: 1, trained_pharmacist_available: 1,
          inventory_available: 1, future_slot_available: 1,
        };
      } }) }),
    } as unknown as D1Database;

    const readiness = await getPharmacyReadiness(db, 'account-a', new Date('2026-08-21T00:00:00.000Z'));

    expect(readiness).toEqual({
      accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
      electronicPrescription: {
        status: 'UNVERIFIED', capabilityEnabled: true, endpointConfigured: true,
        endpointEvidence: {
          status: 'UNVERIFIED', source: 'manual_console',
          checkedAt: null, freshnessHours: 24,
        },
      },
      emergencyContraception: {
        status: 'READY', capabilityEnabled: true, requirementsComplete: true,
        trainedPharmacistAvailable: true,
        inventoryAvailable: true, futureSlotAvailable: true,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([
      '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
      '2026-08-21T00:00:00.000Z', 'account-a',
    ]);
    expect(calls[0].sql).toContain('assignment.is_active = 1');
    expect(calls[0].sql).toContain('active.expires_at > ?');
    expect(calls[0].sql).toContain('settings.privacy_space_ready = 1');
    expect(JSON.stringify(readiness)).not.toMatch(/"(?:friend|patient|reference|risk|credential|count)[^"]*"/iu);
  });

  it('uses the same instant for net stock and non-expired slot occupancy', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
      calls.push({ sql, values });
      return {
        id: 'account-a', capabilities_json: '["emergency_contraception"]', endpoint_configured: 0,
        emergency_requirements_complete: 1, trained_pharmacist_available: 1,
        inventory_available: 1, future_slot_available: 1,
      };
    } }) }) } as unknown as D1Database;

    await getPharmacyReadiness(db, 'account-a', new Date('2026-08-21T00:00:00.000Z'));

    expect(calls[0].values).toEqual([
      '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
      '2026-08-21T00:00:00.000Z', 'account-a',
    ]);
  });

  it('returns BLOCKED booleans without inventing a row for another account', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
    await expect(getPharmacyReadiness(db, 'missing')).resolves.toBeNull();
  });
});
