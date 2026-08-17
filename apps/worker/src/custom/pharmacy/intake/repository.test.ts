import { describe, expect, it, vi } from 'vitest';
import {
  createPharmacyPatient,
  createPatientIntakeResponse,
  getAdminPharmacyPatientHistory,
  getLatestAdminPatientIntake,
  getLatestPatientIntake,
  listAdminPharmacyPatients,
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
      postalCode: null,
      prefecture: null,
      city: null,
      addressLine1: null,
      addressLine2: null,
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
      postalCode: null,
      prefecture: null,
      city: null,
      addressLine1: null,
      addressLine2: null,
    })).rejects.toThrow('invalid patient profile');
    expect(calls).toHaveLength(0);
  });

  it('rejects a partial address before touching D1', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'self', name: '患者', nameKana: 'カンジャ', birthDate: '2000-01-01',
      sex: null, contactPhone: null, postalCode: '100-0001', prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
    })).rejects.toThrow('invalid patient address');
    expect(calls).toHaveLength(0);
  });

  it('normalizes an optional phone and delivery address into the patient profile', async () => {
    const { db } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'self', name: '患者', nameKana: 'カンジャ', birthDate: '2000-01-01',
      sex: null, contactPhone: ' 03-0000-0000 ', postalCode: '100-0001', prefecture: '東京都',
      city: '千代田区', addressLine1: '千代田1-1', addressLine2: '薬局ビル 101',
    })).resolves.toMatchObject({
      contact_phone: '03-0000-0000', postal_code: '100-0001', prefecture: '東京都',
      city: '千代田区', address_line1: '千代田1-1', address_line2: '薬局ビル 101',
    });
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

  it('does not expose account linkage in the admin patient list', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, postal_code: null, prefecture: null, city: null,
      address_line1: null, address_line2: null, archived_at: null,
    };
    const { db } = fakeDb(null, [patient]);

    const patients = await listAdminPharmacyPatients(db, 'account-1');

    expect(patients[0]).toMatchObject({ id: 'patient-1', name: '患者' });
    expect(patients[0]).not.toHaveProperty('line_account_id');
    expect(patients[0]).not.toHaveProperty('owner_friend_id');
  });

  it('loads a patient history using the account and patient scope for every query', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, postal_code: null, prefecture: null, city: null,
      address_line1: null, address_line2: null, archived_at: null,
    };
    const { db, calls } = fakeDb(patient, []);
    await expect(getAdminPharmacyPatientHistory(db, 'account-1', 'patient-1')).resolves.toMatchObject({
      patient: { id: 'patient-1' }, intakes: [], prescriptions: [], quotes: [],
      continuity: [], medicationFollowUps: [], timeline: [],
    });
    expect(calls).toHaveLength(10);
    expect(calls.slice(1).every((call) => call.values.includes('account-1') && call.values.includes('patient-1'))).toBe(true);
    expect(calls.slice(1).every((call) => !call.sql.includes('line_user_id'))).toBe(true);
    const eventSql = calls.find((call) => call.sql.includes('pharmacy_prescription_events'))?.sql;
    expect(eventSql).toContain('INNER JOIN pharmacy_prescription_submissions s');
    expect(eventSql).toContain('pp.line_account_id = s.line_account_id');
    expect(eventSql).not.toContain('e.line_account_id');
    const followUpEventSql = calls.find((call) => call.sql.includes('pharmacy_medication_followup_events'))?.sql;
    expect(followUpEventSql).toContain('e.line_account_id = ?');
    expect(followUpEventSql).toContain('f.patient_id = ?');
  });

  it('returns only the latest allowlisted intake answers without raw snapshots', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, postal_code: null, prefecture: null, city: null,
      address_line1: null, address_line2: null, archived_at: null,
    };
    const intake = {
      id: 'intake-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      patient_id: 'patient-1', revision: 1, schema_version: 2,
      patient_snapshot_json: '{"name":"raw snapshot"}',
      answers_json: JSON.stringify({
        allergiesStatus: 'yes', allergiesDetail: '花粉', futureSecret: 'do-not-return',
      }),
      base_response_id: null, idempotency_key: 'private-key',
      representative_consent_at: '2026-08-17T00:00:00Z',
      privacy_consent_at: '2026-08-17T00:00:00Z', created_at: '2026-08-17T00:00:00Z',
    };
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => patient,
          all: async () => ({
            results: sql.includes('pharmacy_patient_intake_responses') ? [intake] : [],
          }),
        }),
      }),
    } as unknown as D1Database;

    const history = await getAdminPharmacyPatientHistory(db, 'account-1', 'patient-1');

    expect(history?.latestIntake).toMatchObject({
      id: 'intake-1',
      answers: { allergiesStatus: 'yes', allergiesDetail: '花粉' },
    });
    expect(history?.intakes[0]).not.toHaveProperty('answers_json');
    expect(history?.latestIntake).not.toHaveProperty('patient_snapshot_json');
    expect(JSON.stringify(history)).not.toContain('do-not-return');
    expect(JSON.stringify(history)).not.toContain('private-key');
  });

  it('does not expose account linkage or raw intake fields from admin reads', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, postal_code: null, prefecture: null, city: null,
      address_line1: null, address_line2: null, archived_at: null,
    };
    const intake = {
      id: 'intake-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      patient_id: 'patient-1', revision: 1, schema_version: 2,
      patient_snapshot_json: '{"name":"raw snapshot"}',
      answers_json: JSON.stringify({ allergiesStatus: 'none', futureSecret: 'hidden' }),
      base_response_id: null, idempotency_key: 'private-key',
      representative_consent_at: '2026-08-17T00:00:00Z',
      privacy_consent_at: '2026-08-17T00:00:00Z', created_at: '2026-08-17T00:00:00Z',
    };
    const historyDb = {
      prepare: (sql: string) => ({ bind: () => ({
        first: async () => patient,
        all: async () => ({ results: sql.includes('pharmacy_patient_intake_responses') ? [intake] : [] }),
      }) }),
    } as unknown as D1Database;
    const latestDb = fakeDb(intake).db;

    const history = await getAdminPharmacyPatientHistory(historyDb, 'account-1', 'patient-1');
    const latest = await getLatestAdminPatientIntake(latestDb, 'account-1', 'patient-1');

    expect(history?.patient).not.toHaveProperty('line_account_id');
    expect(history?.patient).not.toHaveProperty('owner_friend_id');
    expect(latest).toMatchObject({ answers: { allergiesStatus: 'none' } });
    expect(JSON.stringify(latest)).not.toContain('raw snapshot');
    expect(JSON.stringify(latest)).not.toContain('private-key');
    expect(JSON.stringify(latest)).not.toContain('hidden');
  });

  it('updates a patient profile with owner-scoped optimistic concurrency', async () => {
    const { db, calls } = fakeDb(null);
    await expect(updatePharmacyPatient(db, owner, 'patient-1', '2026-08-17T00:00:00.000Z', {
      relationship: 'child', name: '更新患者', nameKana: 'コウシンカンジャ',
      birthDate: '2018-04-01', sex: null, contactPhone: null,
      postalCode: null, prefecture: null, city: null, addressLine1: null, addressLine2: null,
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
        medicationStatus: 'none',
        medicationSummary: '',
        medicalHistoryStatus: 'none',
        medicalHistoryTags: [],
        medicalHistory: '',
        medicationNotebook: 'unknown',
        smokingStatus: 'never',
        alcoholStatus: 'none',
        medicationAdherence: 'none',
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

  it('rejects intake answers missing the selection fields', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb(patient);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: { allergiesStatus: 'none', adverseReactionStatus: 'none' } as never,
      representativeConsent: true,
      privacyConsent: true,
    })).rejects.toThrow('invalid intake answers');
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown medical history tags', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb(patient);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'yes', medicalHistoryTags: ['unknown-condition'],
        medicationNotebook: 'unknown',
      } as never,
      representativeConsent: true,
      privacyConsent: true,
    })).rejects.toThrow('invalid intake answers');
    expect(calls).toHaveLength(0);
  });

  it('rejects unsupported lifestyle or adherence values', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb(patient);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'unsupported', alcoholStatus: 'none', medicationAdherence: 'none',
      } as never,
      representativeConsent: true,
      privacyConsent: true,
    })).rejects.toThrow('invalid intake answers');
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
