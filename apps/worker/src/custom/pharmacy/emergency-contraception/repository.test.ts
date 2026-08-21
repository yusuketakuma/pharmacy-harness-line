import { describe, expect, it } from 'vitest';
import { saveEmergencySettings } from './repository.js';

function settingsDb(
  calls: Array<{ sql: string; values: unknown[] }>,
  currentRow: { purpose_text: string; retention_days: number; consent_version: string } | null,
): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => currentRow,
        run: async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
      }),
    }),
  } as unknown as D1Database;
}

describe('emergency contraception settings authority', () => {
  it('derives enabled state from the canonical capability and never overwrites it on config updates', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = settingsDb(calls, null);

    await saveEmergencySettings(db, {
      lineAccountId: 'account-a', staffId: 'staff-a', pharmacyRegistrationNumber: 'REG-A',
      productCode: 'norlevo-otc', manufacturerCheckUrl: 'https://manufacturer.example/check',
      privacyPolicyUrl: 'https://pharmacy.example/privacy', privacyContact: 'privacy@example.test',
      purposeText: '対面相談受付', consentVersion: '2026-08-21', retentionDays: 30,
      consultationMinutes: 30, reservationTtlMinutes: 30, privacySpaceReady: true,
      drinkingWaterReady: true, partnerClinicUrl: 'https://clinic.example',
      supportCenterUrl: 'https://support.example',
    });

    expect(calls[0].sql).toContain("value = 'emergency_contraception'");
    expect(calls[0].sql).not.toContain('is_enabled = excluded.is_enabled');
    expect(calls[0].values.slice(0, 2)).toEqual(['account-a', 'account-a']);
  });

  it('rejects a purpose_text or retention_days change that keeps the same consent_version', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const base = {
      lineAccountId: 'account-a', staffId: 'staff-a', pharmacyRegistrationNumber: 'REG-A',
      productCode: 'norlevo-otc', manufacturerCheckUrl: 'https://manufacturer.example/check',
      privacyPolicyUrl: 'https://pharmacy.example/privacy', privacyContact: 'privacy@example.test',
      consultationMinutes: 30, reservationTtlMinutes: 30, privacySpaceReady: true,
      drinkingWaterReady: true, partnerClinicUrl: 'https://clinic.example',
      supportCenterUrl: 'https://support.example',
    };

    await expect(saveEmergencySettings(settingsDb(calls, {
      purpose_text: '旧・対面相談受付', retention_days: 30, consent_version: '2026-08-21',
    }), {
      ...base, purposeText: '新・対面相談受付', consentVersion: '2026-08-21', retentionDays: 30,
    })).rejects.toThrow('EMERGENCY_CONSENT_VERSION_STALE');

    await expect(saveEmergencySettings(settingsDb(calls, {
      purpose_text: '対面相談受付', retention_days: 30, consent_version: '2026-08-21',
    }), {
      ...base, purposeText: '対面相談受付', consentVersion: '2026-08-21', retentionDays: 60,
    })).rejects.toThrow('EMERGENCY_CONSENT_VERSION_STALE');

    // Bumping consent_version alongside the wording/retention change is allowed.
    await expect(saveEmergencySettings(settingsDb(calls, {
      purpose_text: '旧・対面相談受付', retention_days: 30, consent_version: '2026-08-21',
    }), {
      ...base, purposeText: '新・対面相談受付', consentVersion: '2026-08-22', retentionDays: 30,
    })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
