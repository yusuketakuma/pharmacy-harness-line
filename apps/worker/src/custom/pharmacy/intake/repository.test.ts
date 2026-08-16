import { describe, expect, it, vi } from 'vitest';
import {
  createPharmacyPatient,
  createPatientIntakeResponse,
  getLatestPatientIntake,
  listPharmacyPatients,
  updatePharmacyPatient,
} from './repository.js';

function fakeDb(row: unknown | unknown[], allRows: unknown[] = []): {
  db: D1Database;
  calls: Array<{ sql: string; values: unknown[]; operation: string }>;
} {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const firstRows = Array.isArray(row) ? [...row] : [row];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      run: async () => {
        calls.push({ sql, values, operation: 'run' });
        return { success: true, meta: { changes: 1 } };
      },
      first: async () => {
        calls.push({ sql, values, operation: 'first' });
        return firstRows.shift() ?? null;
      },
      all: async () => {
        calls.push({ sql, values, operation: 'all' });
        return { results: allRows };
      },
    }),
  }));
  return { db: { prepare } as unknown as D1Database, calls };
}

const owner = { lineAccountId: 'account-1', friendId: 'friend-1' };

describe('pharmacy patient repository', () => {
  it('validates and inserts a family patient in the owner scope', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'child',
      name: '患者 子',
      nameKana: 'カンジャ コ',
      birthDate: '2018-04-01',
      sex: null,
      contactPhone: null,
    })).resolves.toMatchObject({ id: expect.any(String) });
    expect(calls[0].sql).toContain('INSERT INTO pharmacy_patients');
    expect(calls[0].sql).toContain('line_account_id');
    expect(calls[0].values).toContain('account-1');
    expect(calls[0].values).toContain('friend-1');
  });

  it('rejects malformed profile data before touching D1', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'child',
      name: '',
      nameKana: 'カンジャ',
      birthDate: '2018/04/01',
      sex: null,
      contactPhone: null,
    })).rejects.toThrow('invalid patient profile');
    expect(calls).toHaveLength(0);
  });

  it('lists only active patients for the authenticated owner', async () => {
    const { db, calls } = fakeDb(null, [{ id: 'patient-1', relationship: 'self' }]);
    await expect(listPharmacyPatients(db, owner)).resolves.toEqual([
      { id: 'patient-1', relationship: 'self' },
    ]);
    expect(calls[0].sql).toContain('line_account_id = ? AND owner_friend_id = ?');
    expect(calls[0].sql).toContain('archived_at IS NULL');
    expect(calls[0].values).toEqual(['account-1', 'friend-1']);
  });

  it('updates a patient profile with owner-scoped optimistic concurrency', async () => {
    const { db, calls } = fakeDb(null);
    await expect(updatePharmacyPatient(db, owner, 'patient-1', '2026-08-17T00:00:00.000Z', {
      relationship: 'child', name: '更新患者', nameKana: 'コウシンカンジャ',
      birthDate: '2018-04-01', sex: null, contactPhone: null,
    })).resolves.toBeUndefined();
    expect(calls[0].sql).toContain('UPDATE pharmacy_patients');
    expect(calls[0].sql).toContain('owner_friend_id = ?');
  });

  it('creates an immutable intake revision with consent and a patient snapshot', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb([patient, { id: 'response-1', revision: 1 }]);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none',
        adverseReactionStatus: 'none',
        medicationSummary: '',
        medicalHistory: '',
        pregnancyStatus: 'not_applicable',
        breastfeedingStatus: 'not_applicable',
        notes: '',
      },
      representativeConsent: true,
      privacyConsent: true,
    })).resolves.toMatchObject({ id: expect.any(String), revision: 1 });
    expect(calls[0].sql).toContain('FROM pharmacy_patients');
    expect(calls[1].sql).toContain('INSERT INTO pharmacy_patient_intake_responses');
    expect(calls[1].values).toContain('account-1');
    expect(calls[1].values).toContain('friend-1');
    expect(calls[1].values).toContain('patient-1');
  });

  it('rejects intake without both consents or required status answers', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb(patient);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: { allergiesStatus: 'none' } as never,
      representativeConsent: true,
      privacyConsent: false,
    })).rejects.toThrow('intake consent required');
    expect(calls).toHaveLength(0);
  });

  it('loads the newest intake revision within the owner scope', async () => {
    const { db, calls } = fakeDb({ id: 'response-2', revision: 2 });
    await expect(getLatestPatientIntake(db, owner, 'patient-1')).resolves.toEqual({
      id: 'response-2', revision: 2,
    });
    expect(calls[0].sql).toContain('line_account_id = ? AND owner_friend_id = ?');
    expect(calls[0].values).toEqual(['account-1', 'friend-1', 'patient-1']);
  });
});
