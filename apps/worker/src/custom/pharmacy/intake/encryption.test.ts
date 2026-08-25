import { describe, expect, it } from 'vitest';
import {
  INVALID_PATIENT_INTAKE_ENVELOPE_ERROR,
  openPatientIntakeField,
  sealPatientIntakeField,
  type PatientIntakeEncryptionContext,
} from './encryption.js';

const ROOT_SECRET = 'synthetic-pharmacy-phi-root-secret-v1';
const ROOT_SECRET_V2 = 'synthetic-pharmacy-phi-root-secret-v2';
const CONTEXT: PatientIntakeEncryptionContext = {
  tenantId: 'tenant-a', lineAccountId: 'account-a', ownerFriendId: 'friend-a',
  patientId: 'patient-a', responseId: 'response-a', schemaVersion: 2,
  sourceRevision: 1, fieldName: 'answers_json', envelopeVersion: 1, keyVersion: 1,
};

describe('pharmacy patient intake field encryption', () => {
  it('round-trips exact JSON with a fresh 96-bit nonce', async () => {
    const plaintext = JSON.stringify({
      allergiesStatus: 'none', notes: ` 処方内容 ${'あ'.repeat(2200)} `,
    });
    const first = await sealPatientIntakeField(plaintext, ROOT_SECRET, CONTEXT);
    const second = await sealPatientIntakeField(plaintext, ROOT_SECRET, CONTEXT);
    expect(first).toMatchObject({ envelopeVersion: 1, keyVersion: 1 });
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    expect(first.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(second.nonce).not.toBe(first.nonce);
    await expect(openPatientIntakeField(first, ROOT_SECRET, CONTEXT)).resolves.toBe(plaintext);
  });

  it('fails closed for AAD scope or field substitution and tampering', async () => {
    const encrypted = await sealPatientIntakeField('{}', ROOT_SECRET, CONTEXT);
    const contexts = [
      { ...CONTEXT, tenantId: 'tenant-b' },
      { ...CONTEXT, lineAccountId: 'account-b' },
      { ...CONTEXT, ownerFriendId: 'friend-b' },
      { ...CONTEXT, patientId: 'patient-b' },
      { ...CONTEXT, responseId: 'response-b' },
      { ...CONTEXT, sourceRevision: 2 },
      { ...CONTEXT, fieldName: 'patient_snapshot_json' as const },
    ];
    for (const context of contexts) {
      await expect(openPatientIntakeField(encrypted, ROOT_SECRET, context))
        .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    }
    await expect(openPatientIntakeField({
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -1)}${encrypted.ciphertext.endsWith('A') ? 'B' : 'A'}`,
    }, ROOT_SECRET, CONTEXT)).rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  });

  it('supports a separately rooted v2 key while rejecting key substitution', async () => {
    const context = { ...CONTEXT, keyVersion: 2 };
    const encrypted = await sealPatientIntakeField('{}', ROOT_SECRET_V2, context);

    expect(encrypted.keyVersion).toBe(2);
    await expect(openPatientIntakeField(encrypted, ROOT_SECRET_V2, context)).resolves.toBe('{}');
    await expect(openPatientIntakeField(encrypted, ROOT_SECRET, context))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  });

  it('rejects missing secrets, malformed data, non-object JSON, and unknown versions', async () => {
    await expect(sealPatientIntakeField('{}', '', CONTEXT))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    await expect(sealPatientIntakeField('[]', ROOT_SECRET, CONTEXT))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    const encrypted = await sealPatientIntakeField('{}', ROOT_SECRET, CONTEXT);
    await expect(openPatientIntakeField({ ...encrypted, nonce: `${encrypted.nonce}=` }, ROOT_SECRET, CONTEXT))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    await expect(openPatientIntakeField({ ...encrypted, keyVersion: 3 }, ROOT_SECRET, CONTEXT))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    await expect(openPatientIntakeField(encrypted, ROOT_SECRET, { ...CONTEXT, envelopeVersion: 2 }))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  });
});
