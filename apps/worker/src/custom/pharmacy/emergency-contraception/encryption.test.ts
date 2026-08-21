import { describe, expect, it } from 'vitest';
import { openEmergencyPayload, sealEmergencyPayload } from './encryption.js';

const context = {
  tenantId: 'tenant-a',
  lineAccountId: 'account-a',
  friendId: 'friend-a',
  intakeId: 'intake-a',
};

describe('emergency intake encryption', () => {
  it('round-trips the minimal payload without exposing its timestamp', async () => {
    const payload = {
      intercourseAt: '2026-08-18T10:00:00+09:00',
      intercourseTimeUnknown: false,
    };
    const encrypted = await sealEmergencyPayload(payload, 'test-secret', context);

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('2026-08-18');
    await expect(openEmergencyPayload(encrypted, 'test-secret', context)).resolves.toEqual(payload);
  });

  it('binds ciphertext to tenant, account, patient, and intake', async () => {
    const encrypted = await sealEmergencyPayload({ intercourseAt: 'x', intercourseTimeUnknown: true }, 'secret', context);
    await expect(openEmergencyPayload(encrypted, 'secret', {
      ...context,
      lineAccountId: 'account-b',
    })).rejects.toThrow('encrypted intake is invalid');
  });

  it('fails closed without a configured secret', async () => {
    await expect(sealEmergencyPayload({}, '', context)).rejects.toThrow('encryption key is not configured');
  });

  it('seals the maximal v2 pre-visit payload (Phase A only) within the 2048 byte cap', async () => {
    const payload = {
      schema_version: 2,
      intercourseAt: '2026-08-18T10:00:00+09:00',
      intercourseTimeUnknown: false,
      lngAllergy: true,
      liverDisease: true,
      currentlyPregnant: true,
      breastfeeding: true,
      detailFlags: ['lng_allergy', 'liver_disease', 'pregnancy_reported', 'breastfeeding_advice'],
      checklistVersion: 'lng-2026-08',
      consentContentHash: 'a'.repeat(64),
    };
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(plaintextBytes).toBeLessThanOrEqual(2048);

    const encrypted = await sealEmergencyPayload(payload, 'test-secret', context);
    expect(encrypted).toMatch(/^v1\./);
    await expect(openEmergencyPayload(encrypted, 'test-secret', context)).resolves.toEqual(payload);
  });

  // ECF-6 (Phase B): B1-B4, C1/C2, D3 added to the v2 payload on top of Phase A.
  // Measured plaintext size is 853 bytes, well within the 2048 byte cap — no
  // key-derivation change (HMAC + key version) is required for this addition.
  it('seals the maximal v2 payload including Phase B (B1-B4/C1-C2/D3) within the 2048 byte cap', async () => {
    const payload = {
      schema_version: 2,
      intercourseAt: '2026-08-18T10:00:00+09:00',
      intercourseTimeUnknown: false,
      lngAllergy: true,
      liverDisease: true,
      currentlyPregnant: true,
      breastfeeding: true,
      underMedicalTreatment: true,
      drugAllergyHistory: true,
      heartKidneyGiDisease: true,
      stJohnsWort: true,
      lastMenstruationDate: '2026-08-01',
      menstruationSignals: {
        noneApply: false,
        unknown: false,
        overOneMonthNoPeriod: true,
        notRecoveredAfterBirth: true,
        lastPeriodDifferent: true,
        earlierConcernOver3Weeks: true,
      },
      pregnancyTestRecommended: true,
      idDocumentAvailable: true,
      detailFlags: [
        'lng_allergy', 'liver_disease', 'pregnancy_reported', 'breastfeeding_advice',
        'under_medical_treatment', 'drug_allergy_history', 'heart_kidney_gi_disease', 'st_johns_wort',
      ],
      checklistVersion: 'lng-2026-08',
      consentContentHash: 'a'.repeat(64),
    };
    const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(plaintextBytes).toBeLessThanOrEqual(2048); // measured: 853 bytes

    const encrypted = await sealEmergencyPayload(payload, 'test-secret', context);
    expect(encrypted).toMatch(/^v1\./);
    await expect(openEmergencyPayload(encrypted, 'test-secret', context)).resolves.toEqual(payload);
  });

  it('decrypts a fixed v1-shaped payload (no schema_version, no v2 fields) through the same read path', async () => {
    const v1Payload = {
      intercourseAt: '2026-08-18T10:00:00+09:00',
      intercourseTimeUnknown: false,
    };
    const encrypted = await sealEmergencyPayload(v1Payload, 'test-secret', context);
    await expect(openEmergencyPayload(encrypted, 'test-secret', context)).resolves.toEqual(v1Payload);
  });
});
