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

  it('seals the maximal v2 pre-visit payload within the 2048 byte cap', async () => {
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

  it('decrypts a fixed v1-shaped payload (no schema_version, no v2 fields) through the same read path', async () => {
    const v1Payload = {
      intercourseAt: '2026-08-18T10:00:00+09:00',
      intercourseTimeUnknown: false,
    };
    const encrypted = await sealEmergencyPayload(v1Payload, 'test-secret', context);
    await expect(openEmergencyPayload(encrypted, 'test-secret', context)).resolves.toEqual(v1Payload);
  });
});
