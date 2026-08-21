import { describe, expect, it } from 'vitest';
import { saveEmergencySettings } from './repository.js';

describe('emergency contraception settings authority', () => {
  it('derives enabled state from the canonical capability and never overwrites it on config updates', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
        }),
      }),
    } as unknown as D1Database;

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
});
