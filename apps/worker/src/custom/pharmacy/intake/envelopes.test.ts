import { describe, expect, it, vi } from 'vitest';

const cryptoMocks = vi.hoisted(() => ({
  open: vi.fn(),
  seal: vi.fn(),
}));

vi.mock('./encryption.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./encryption.js')>(),
  openPatientIntakeField: cryptoMocks.open,
  sealPatientIntakeField: cryptoMocks.seal,
}));

import {
  preparePatientIntakeEnvelopeStatements,
  resolvePatientIntakeCryptoScope,
} from './envelopes.js';

describe('patient intake envelope statements', () => {
  it('activates v2 only when both the separate key and explicit version are valid', () => {
    const bindings = {
      PHARMACY_PHI_KEY_V1: 'v1'.repeat(16),
      PHARMACY_PHI_KEY_V2: 'v2'.repeat(16),
      PHARMACY_PHI_ACTIVE_KEY_VERSION: '2',
    };
    expect(resolvePatientIntakeCryptoScope(bindings, 'tenant-a')).toEqual({
      tenantId: 'tenant-a',
      rootSecret: bindings.PHARMACY_PHI_KEY_V1,
      rootSecretV2: bindings.PHARMACY_PHI_KEY_V2,
      activeKeyVersion: 2,
    });
    expect(resolvePatientIntakeCryptoScope({ ...bindings, PHARMACY_PHI_KEY_V2: 'short' }, 'tenant-a'))
      .toBeNull();
    expect(resolvePatientIntakeCryptoScope({
      ...bindings, PHARMACY_PHI_KEY_V2: bindings.PHARMACY_PHI_KEY_V1,
    }, 'tenant-a')).toBeNull();
    expect(resolvePatientIntakeCryptoScope({ ...bindings, PHARMACY_PHI_ACTIVE_KEY_VERSION: '3' }, 'tenant-a'))
      .toBeNull();
  });

  it('optionally verifies every sealed field before preparing the inserts', async () => {
    cryptoMocks.seal.mockImplementation(async (plaintext: string) => ({
      envelopeVersion: 1,
      keyVersion: 1,
      nonce: `nonce:${plaintext}`,
      ciphertext: `cipher:${plaintext}`,
    }));
    cryptoMocks.open.mockImplementation(async (envelope: { ciphertext: string }) =>
      envelope.ciphertext.slice('cipher:'.length));
    const bind = vi.fn((...values: unknown[]) => ({ values }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;

    const statements = await preparePatientIntakeEnvelopeStatements(
      db,
      {
        id: 'response-a',
        line_account_id: 'account-a',
        owner_friend_id: 'friend-a',
        patient_id: 'patient-a',
        revision: 2,
        schema_version: 1,
        patient_snapshot_json: '{"name":"synthetic"}',
        answers_json: '{"allergiesStatus":"none"}',
      },
      { tenantId: 'tenant-a', rootSecret: 's'.repeat(32) },
      '2026-08-22T00:00:00.000Z',
      true,
    );

    expect(statements).toHaveLength(2);
    expect(cryptoMocks.open).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledTimes(2);
  });

  it('fails closed before preparing an insert when verification does not match', async () => {
    cryptoMocks.seal.mockResolvedValue({
      envelopeVersion: 1,
      keyVersion: 1,
      nonce: 'nonce',
      ciphertext: 'ciphertext',
    });
    cryptoMocks.open.mockResolvedValue('different');
    const prepare = vi.fn();
    const db = { prepare } as unknown as D1Database;

    await expect(preparePatientIntakeEnvelopeStatements(
      db,
      {
        id: 'response-a',
        line_account_id: 'account-a',
        owner_friend_id: 'friend-a',
        patient_id: 'patient-a',
        revision: 2,
        schema_version: 1,
        patient_snapshot_json: '{"name":"synthetic"}',
        answers_json: '{"allergiesStatus":"none"}',
      },
      { tenantId: 'tenant-a', rootSecret: 's'.repeat(32) },
      '2026-08-22T00:00:00.000Z',
      true,
    )).rejects.toThrow('byte mismatch');

    expect(prepare).not.toHaveBeenCalled();
  });
});
