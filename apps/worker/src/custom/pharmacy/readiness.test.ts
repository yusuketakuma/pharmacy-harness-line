import { describe, expect, it } from 'vitest';
import { getPharmacyReadiness, PHARMACY_READINESS_REASON_CODES } from './readiness.js';

describe('canonical pharmacy readiness projection', () => {
  it('returns READY only while the manual endpoint verification is fresh', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ first: async () => {
        calls.push({ sql, values });
        return {
          id: 'account-a', capabilities_json: JSON.stringify(['electronic_prescription', 'emergency_contraception']),
          endpoint_configured: 1, endpoint_checked_at: '2026-08-20T00:00:00.000Z',
          emergency_requirements_complete: 1, trained_pharmacist_available: 1,
          inventory_available: 1, future_slot_available: 1,
          rich_menu_layout_configured: 1, rich_menu_saved_version_available: 1,
          rich_menu_catalog_version_current: 1, rich_menu_published_version_available: 1,
          rich_menu_default_recorded: 1,
          rich_menu_capability_revision_current: 1, rich_menu_upload_verified: 1,
          rich_menu_default_readback_verified: 1,
          rich_menu_evidence_checked_at: '2026-08-20T23:00:00.000Z',
        };
      } }) }),
    } as unknown as D1Database;

    const readiness = await getPharmacyReadiness(db, 'account-a', new Date('2026-08-21T00:00:00.000Z'));

    expect(readiness).toEqual({
      accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
      electronicPrescription: {
        status: 'READY', capabilityEnabled: true, endpointConfigured: true,
        reasonCodes: [],
        endpointEvidence: {
          status: 'READY', source: 'manual_console',
          checkedAt: '2026-08-20T00:00:00.000Z', freshnessHours: 24,
        },
      },
      emergencyContraception: {
        status: 'READY', capabilityEnabled: true, requirementsComplete: true,
        trainedPharmacistAvailable: true,
        inventoryAvailable: true, futureSlotAvailable: true,
        reasonCodes: [],
      },
      richMenu: {
        status: 'BLOCKED', syncStatus: 'UNVERIFIED', capabilityEnabled: false, layoutConfigured: true,
        savedVersionAvailable: true, catalogVersionCurrent: true,
        publishedVersionAvailable: true, currentDefaultRecorded: true,
        capabilityRevisionCurrent: true, uploadVerified: true,
        defaultReadbackVerified: true, evidenceCheckedAt: '2026-08-20T23:00:00.000Z',
        reasonCodes: ['RICH_MENU_CAPABILITY_DISABLED'],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([
      '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
      '2026-08-21T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'account-a',
    ]);
    expect(calls[0].sql).toContain('assignment.is_active = 1');
    expect(calls[0].sql).toContain('active.expires_at > ?');
    expect(calls[0].sql).toContain('settings.privacy_space_ready = 1');
    const capabilityProjectionEnd = calls[0].sql.indexOf('AS rich_menu_capability_revision_current');
    const capabilityProjection = calls[0].sql.slice(capabilityProjectionEnd - 900, capabilityProjectionEnd);
    expect(capabilityProjection).toContain('INNER JOIN rich_menu_groups AS menu');
    expect(capabilityProjection).toContain('menu.is_default_for_all = 1');
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
        rich_menu_layout_configured: 0, rich_menu_saved_version_available: 0,
        rich_menu_catalog_version_current: 0, rich_menu_published_version_available: 0,
        rich_menu_default_recorded: 0,
        rich_menu_capability_revision_current: 0, rich_menu_upload_verified: 0,
        rich_menu_default_readback_verified: 0, rich_menu_evidence_checked_at: null,
      };
    } }) }) } as unknown as D1Database;

    await getPharmacyReadiness(db, 'account-a', new Date('2026-08-21T00:00:00.000Z'));

    expect(calls[0].values).toEqual([
      '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
      '2026-08-21T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'account-a',
    ]);
  });

  it('returns BLOCKED booleans without inventing a row for another account', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
    await expect(getPharmacyReadiness(db, 'missing')).resolves.toBeNull();
  });

  it('returns fixed reasons and READY only for a fresh verified rich-menu read-back', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({
      id: 'account-a',
      capabilities_json: JSON.stringify(['electronic_prescription', 'emergency_contraception', 'pharmacy_rich_menu']),
      endpoint_configured: 0,
      emergency_requirements_complete: 0, trained_pharmacist_available: 0,
      inventory_available: 0, future_slot_available: 0,
      rich_menu_layout_configured: 1, rich_menu_saved_version_available: 1,
      rich_menu_catalog_version_current: 1, rich_menu_published_version_available: 1,
      rich_menu_default_recorded: 1, rich_menu_capability_revision_current: 1,
      rich_menu_upload_verified: 1, rich_menu_default_readback_verified: 1,
      rich_menu_evidence_checked_at: '2026-08-20T23:00:00.000Z',
    }) }) }) } as unknown as D1Database;

    const readiness = await getPharmacyReadiness(db, 'account-a', new Date('2026-08-21T00:00:00.000Z'));

    expect(readiness?.electronicPrescription.reasonCodes).toEqual(['ELECTRONIC_ENDPOINT_MISSING']);
    expect(readiness?.emergencyContraception.reasonCodes).toEqual([
      'EMERGENCY_REQUIREMENTS_INCOMPLETE', 'EMERGENCY_TRAINED_PHARMACIST_MISSING',
      'EMERGENCY_INVENTORY_UNAVAILABLE', 'EMERGENCY_FUTURE_SLOT_UNAVAILABLE',
    ]);
    expect(readiness?.richMenu).toMatchObject({
      status: 'READY', syncStatus: 'CURRENT', reasonCodes: [],
    });
    for (const reason of [
      ...(readiness?.electronicPrescription.reasonCodes ?? []),
      ...(readiness?.emergencyContraception.reasonCodes ?? []),
      ...(readiness?.richMenu.reasonCodes ?? []),
    ]) expect(PHARMACY_READINESS_REASON_CODES).toContain(reason);
    expect(JSON.stringify(readiness)).not.toMatch(/patient|friend|reference|credential|token|secret|activeCount/iu);
  });

  it('marks the public rich menu STALE when its capability revision is old', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({
      id: 'account-a', capabilities_json: JSON.stringify(['pharmacy_rich_menu']), endpoint_configured: 0,
      emergency_requirements_complete: 0, trained_pharmacist_available: 0,
      inventory_available: 0, future_slot_available: 0,
      rich_menu_layout_configured: 1, rich_menu_saved_version_available: 1,
      rich_menu_catalog_version_current: 1, rich_menu_published_version_available: 1,
      rich_menu_default_recorded: 1, rich_menu_capability_revision_current: 0,
      rich_menu_upload_verified: 1, rich_menu_default_readback_verified: 1,
      rich_menu_evidence_checked_at: '2026-08-20T23:00:00.000Z',
    }) }) }) } as unknown as D1Database;

    const readiness = await getPharmacyReadiness(
      db, 'account-a', new Date('2026-08-21T00:00:00.000Z'),
    );
    expect(readiness?.richMenu).toMatchObject({
      status: 'BLOCKED', syncStatus: 'STALE', capabilityRevisionCurrent: false,
      reasonCodes: expect.arrayContaining(['RICH_MENU_CAPABILITY_REVISION_STALE']),
    });
  });
});
