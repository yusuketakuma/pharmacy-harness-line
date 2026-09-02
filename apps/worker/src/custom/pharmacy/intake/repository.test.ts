import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  archivePharmacyPatient,
  createPharmacyPatient,
  createPatientIntakeResponse,
  getAdminPharmacyPatientHistory,
  getLatestAdminPatientIntake,
  getLatestPatientIntake,
  listAdminPharmacyPatients,
  listPharmacyPatients,
  PATIENT_PROXY_TERMS_HASH,
  PATIENT_PROXY_TERMS_TEXT,
  revokePatientProxyGrant,
  setPatientPrivacyConsent,
  suspendPatientBinding,
  type PharmacyPatient,
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
      __sql: sql,
      __values: values,
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
  const db = {
    prepare,
    batch: async (statements: Array<{ __sql: string; __values: unknown[] }>) => {
      for (const statement of statements) {
        calls.push({ sql: statement.__sql, values: statement.__values, operation: 'batch' });
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, calls };
}

const owner = { lineAccountId: 'account-1', friendId: 'friend-1' };
const cryptoScope = {
  tenantId: 'tenant-1', rootSecret: 'synthetic-pharmacy-phi-root-secret-v1',
};
const policy = { policy_version: 1, content_hash: 'a'.repeat(64) };
const policyProof = {
  privacyPolicyVersion: policy.policy_version,
  privacyPolicyHash: policy.content_hash,
};

describe('pharmacy patient repository', () => {
  afterEach(() => vi.useRealTimers());

  it('creates a minor child and fixed 90-day proxy grant atomically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
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
      proxyConsent: { accepted: true, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
      registrationIdempotencyKey: 'register-child-1',
    })).resolves.toMatchObject({ relationship: 'child' });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.operation === 'batch')).toBe(true);
    expect(calls[1].sql).toContain('INSERT INTO pharmacy_patient_proxy_grants');
    expect(calls[1].sql).toContain("'patient_intake_v1'");
    expect(calls[1].sql).toContain("'self_attested_guardian'");
    expect(calls[1].values).toContain('2026-12-01T00:00:00.000Z');
    expect(calls[2].sql).toContain("'proxy_granted'");
    expect(calls[0].sql).toContain('registration_idempotency_key');
    expect(calls[2].sql).toContain('terms_hash');
  });

  it.each([
    ['child', '2000-04-01'],
    ['spouse', '2000-04-01'],
    ['parent', '1950-04-01'],
    ['other', '2000-04-01'],
  ] as const)('keeps unverified adult relationship %s closed', async (relationship, birthDate) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship, name: '患者', nameKana: 'カンジャ', birthDate,
      sex: null, contactPhone: null, postalCode: null, prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
      proxyConsent: { accepted: true, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
    })).rejects.toThrow('adult family verification required');
    expect(calls).toHaveLength(0);
  });

  it('uses the Japan calendar date for the exact 18-year boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T16:00:00.000Z'));
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'child', name: '患者', nameKana: 'カンジャ', birthDate: '2008-09-02',
      sex: null, contactPhone: null, postalCode: null, prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
      proxyConsent: { accepted: true, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
    })).rejects.toThrow('adult family verification required');
    expect(calls).toHaveLength(0);
  });

  it('requires the current proxy terms before creating a child', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'child', name: '患者', nameKana: 'カンジャ', birthDate: '2018-04-01',
      sex: null, contactPhone: null, postalCode: null, prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
      proxyConsent: { accepted: false, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
    })).rejects.toThrow('proxy consent required');
    expect(calls).toHaveLength(0);
  });

  it('preserves the previous family rejection for clients without proxy consent fields', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'child', name: '患者', nameKana: 'カンジャ', birthDate: '2018-04-01',
      sex: null, contactPhone: null, postalCode: null, prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
    })).rejects.toThrow('proxy grant required');
    expect(calls).toHaveLength(0);
  });

  it('binds the recorded proxy hash to the canonical terms text', () => {
    expect(createHash('sha256').update(PATIENT_PROXY_TERMS_TEXT).digest('hex'))
      .toBe(PATIENT_PROXY_TERMS_HASH);
  });

  it('revokes the exact owner-scoped proxy grant and writes an audit event atomically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    const { db, calls } = fakeDb({ id: 'grant-1', revoked_at: null, version: 1 });
    await expect(revokePatientProxyGrant(db, owner, 'patient-1')).resolves.toEqual({ status: 'revoked' });
    expect(calls[0].sql).toContain('line_account_id = ?');
    expect(calls[0].values).toEqual(['account-1', 'patient-1', 'friend-1']);
    expect(calls[1].sql).toContain('UPDATE pharmacy_patient_proxy_grants');
    expect(calls[1].sql).toContain('last_transition_id = ?');
    expect(calls[2].sql).toContain("'proxy_revoked'");
    expect(calls[2].sql).toContain('grant.last_transition_id = ?');
    expect(calls.slice(1).every((call) => call.operation === 'batch')).toBe(true);
  });

  it('suspends a wrong LINE binding without moving patient ownership', async () => {
    const { db, calls } = fakeDb({
      owner_friend_id: 'friend-1', binding_suspended_at: null, version: 0,
    });

    await expect(suspendPatientBinding(
      db, 'account-1', 'patient-1', 'staff-1', 'wrong_line_binding',
    )).resolves.toEqual({
      status: 'suspended', controlVersion: 1,
      nextAction: 'recreate_under_verified_owner',
    });

    expect(calls[0].sql).toContain('patient.line_account_id = ?');
    expect(calls[0].values).toEqual(['patient-1', 'account-1']);
    expect(calls[1].sql).toContain('INSERT INTO pharmacy_patient_owner_controls');
    expect(calls[1].sql).toContain('binding_suspended_at');
    expect(calls[1].sql).toContain('last_transition_id');
    expect(calls[1].sql).not.toContain('AND ? = 0');
    expect(calls[2].sql).toContain("'staff'");
    expect(calls[2].sql).toContain("'binding_suspended'");
    expect(calls[2].sql).toContain('UNION ALL');
    expect(calls[2].sql).toContain('WHERE NOT EXISTS');
    expect(calls[2].sql).toContain('SELECT ?, NULL');
    expect(calls[2].values).toContain('staff-1');
    expect(calls.every((call) => !call.sql.includes('UPDATE pharmacy_patients'))).toBe(true);
  });

  it('treats an already suspended binding as an idempotent success', async () => {
    const { db, calls } = fakeDb({
      owner_friend_id: 'friend-1',
      binding_suspended_at: '2026-09-02T00:00:00.000Z',
      version: 2,
    });

    await expect(suspendPatientBinding(
      db, 'account-1', 'patient-1', 'staff-1', 'wrong_line_binding',
    )).resolves.toEqual({
      status: 'suspended', controlVersion: 2,
      nextAction: 'recreate_under_verified_owner',
    });
    expect(calls).toHaveLength(1);
  });

  it('converges on the winner of a concurrent binding suspension', async () => {
    const states = [
      { owner_friend_id: 'friend-1', binding_suspended_at: null, version: 0 },
      { owner_friend_id: 'friend-1', binding_suspended_at: '2026-09-02T00:00:00.000Z', version: 1 },
    ];
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => states.shift() ?? null }) }),
      batch: async () => { throw new Error('constraint failed'); },
    } as unknown as D1Database;

    await expect(suspendPatientBinding(
      db, 'account-1', 'patient-1', 'staff-1', 'wrong_line_binding',
    )).resolves.toEqual({
      status: 'suspended', controlVersion: 1,
      nextAction: 'recreate_under_verified_owner',
    });
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
    expect(calls[0].values.slice(0, 3)).toEqual(['account-1', 'friend-1', 'friend-1']);
    expect(calls[0].sql).toContain('pharmacy_patient_proxy_grants');
    expect(calls[0].sql).toContain('proxy.superseded_at IS NULL');
    expect(calls[0].sql).toContain("date(pharmacy_patients.birth_date, '+18 years')");
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
    await expect(getAdminPharmacyPatientHistory(db, 'account-1', 'patient-1', cryptoScope)).resolves.toMatchObject({
      patient: { id: 'patient-1' }, intakes: [], prescriptions: [], quotes: [],
      continuity: [], medicationFollowUps: [], timeline: [],
    });
    expect(calls).toHaveLength(12);
    expect(calls.slice(1).every((call) => call.values.includes('account-1') && call.values.includes('patient-1'))).toBe(true);
    expect(calls.slice(1).every((call) => !call.sql.includes('line_user_id'))).toBe(true);
    const eventSql = calls.find((call) => call.sql.includes('pharmacy_prescription_events'))?.sql;
    expect(eventSql).toContain('INNER JOIN pharmacy_prescription_submissions s');
    expect(eventSql).toContain('pp.line_account_id = s.line_account_id');
    expect(eventSql).not.toContain('e.line_account_id');
    const followUpEventSql = calls.find((call) => call.sql.includes('pharmacy_medication_followup_events'))?.sql;
    expect(followUpEventSql).toContain('e.line_account_id = ?');
    expect(followUpEventSql).toContain('f.patient_id = ?');
    const nextIntakeSql = calls.find((call) => call.sql.includes('pharmacy_next_intake_expectation_events'))?.sql;
    expect(nextIntakeSql).toContain('e.line_account_id = ? AND expectation.patient_id = ?');
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
          first: async () => sql.includes('pharmacy_patient_intake_migration_state')
            ? null
            : sql.includes('pharmacy_patient_intake_responses') ? intake : patient,
          all: async () => ({
            results: sql.includes('pharmacy_patient_intake_responses') ? [intake] : [],
          }),
        }),
      }),
    } as unknown as D1Database;

    const history = await getAdminPharmacyPatientHistory(db, 'account-1', 'patient-1', cryptoScope);

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
        first: async () => sql.includes('pharmacy_patient_intake_migration_state')
          ? null
          : sql.includes('pharmacy_patient_intake_responses') ? intake : patient,
        all: async () => ({ results: sql.includes('pharmacy_patient_intake_responses') ? [intake] : [] }),
      }) }),
    } as unknown as D1Database;
    const latestDb = fakeDb(intake).db;

    const history = await getAdminPharmacyPatientHistory(historyDb, 'account-1', 'patient-1', cryptoScope);
    const latest = await getLatestAdminPatientIntake(latestDb, 'account-1', 'patient-1', cryptoScope);

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
      relationship: 'self', name: '更新患者', nameKana: 'コウシンカンジャ',
      birthDate: '2018-04-01', sex: null, contactPhone: null,
      postalCode: null, prefecture: null, city: null, addressLine1: null, addressLine2: null,
    })).resolves.toBeUndefined();
    expect(calls[0].sql).toContain('UPDATE pharmacy_patients');
    expect(calls[0].sql).not.toContain('SET relationship =');
    expect(calls[0].sql).toContain("relationship = 'self'");
    expect(calls[0].sql).toContain('owner_friend_id = ?');
    expect(calls[0].sql).toContain("value = 'patient_intake'");
  });

  it('keeps profile archive and privacy controls self-only', async () => {
    const archive = fakeDb(null);
    await expect(archivePharmacyPatient(
      archive.db, owner, 'patient-1', '2026-08-17T00:00:00.000Z',
    )).resolves.toBeUndefined();
    expect(archive.calls[0].sql).toContain("relationship = 'self'");

    const privacy = fakeDb(null);
    await expect(setPatientPrivacyConsent(privacy.db, owner, 'patient-1', {
      action: 'withdraw', expectedControlVersion: 0,
    })).resolves.toEqual({ status: 'withdrawn', version: 1 });
    expect(privacy.calls[0].sql).toContain("patient.relationship = 'self'");
  });

  it('caps a new proxy grant at the Japan-time eighteenth birthday', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    const { db, calls } = fakeDb(null);
    await createPharmacyPatient(db, owner, {
      relationship: 'child', name: '患者', nameKana: 'カンジャ', birthDate: '2008-09-03',
      sex: null, contactPhone: null, postalCode: null, prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
      proxyConsent: { accepted: true, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
      registrationIdempotencyKey: 'register-boundary-1',
    });
    expect(calls[1].values).toContain('2026-09-02T15:00:00.000Z');
  });

  it('returns the existing patient after an identical registration retry wins the unique key', async () => {
    let stored: (PharmacyPatient & { registration_request_hash: string }) | null = null;
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        __sql: sql,
        __values: values,
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => stored,
      }) }),
      batch: async (statements: Array<{ __values: unknown[] }>) => {
        stored = {
          id: 'patient-existing', line_account_id: 'account-1', owner_friend_id: 'friend-1',
          relationship: 'child', name: '患者', name_kana: 'カンジャ', birth_date: '2018-01-01',
          sex: null, contact_phone: null, postal_code: null, prefecture: null, city: null,
          address_line1: null, address_line2: null, archived_at: null,
          registration_request_hash: String(statements[0].__values[15]),
        };
        throw new Error('UNIQUE constraint failed');
      },
    } as unknown as D1Database;
    await expect(createPharmacyPatient(db, owner, {
      relationship: 'child', name: '患者', nameKana: 'カンジャ', birthDate: '2018-01-01',
      sex: null, contactPhone: null, postalCode: null, prefecture: null,
      city: null, addressLine1: null, addressLine2: null,
      proxyConsent: { accepted: true, termsVersion: 1, termsHash: PATIENT_PROXY_TERMS_HASH },
      registrationIdempotencyKey: 'register-retry-1',
    })).resolves.toMatchObject({ id: 'patient-existing' });
  });

  it('creates an immutable intake revision with consent and a patient snapshot', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb([patient, null, policy, null, null]);
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
      ...policyProof,
    }, cryptoScope)).resolves.toMatchObject({ id: expect.any(String), revision: 1 });
    expect(calls[0].sql).toContain('FROM pharmacy_patients');
    const responseWrite = calls.find((call) => call.operation === 'batch' &&
      call.sql.includes('INSERT INTO pharmacy_patient_intake_responses'));
    expect(responseWrite?.values).toEqual(expect.arrayContaining(['account-1', 'friend-1', 'patient-1']));
    expect(responseWrite?.sql).toContain("value = 'patient_intake'");
    expect(responseWrite?.sql).toContain('policy.policy_version = ?');
    expect(responseWrite?.sql).toContain('policy.content_hash = ?');
    expect(calls.filter((call) => call.operation === 'batch' &&
      call.sql.includes('INSERT INTO pharmacy_patient_intake_envelopes'))).toHaveLength(2);
  });

  it('includes the account/environment recovery fence in the normal write guard', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db, calls } = fakeDb([patient, null, policy, null, null]);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-fence',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none',
      },
      representativeConsent: true,
      privacyConsent: true,
      ...policyProof,
    }, cryptoScope)).resolves.toMatchObject({ id: expect.any(String) });

    const responseWrite = calls.find((call) => call.operation === 'batch' &&
      call.sql.includes('INSERT INTO pharmacy_patient_intake_responses'));
    expect(responseWrite?.sql).toContain('pharmacy_recovery_execution_fences');
    expect(responseWrite?.sql).toContain("fence.status = 'active'");
    expect(responseWrite?.values).toEqual(expect.arrayContaining([
      'tenant-1', 'account-1', 'current-worker-binding',
    ]));
  });

  it('fails closed when D1 reports an incomplete encrypted write', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db } = fakeDb([
      patient, null, policy, null, null,
      null, null, patient, policy,
    ]);
    db.batch = vi.fn(async () => [
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ]) as unknown as D1Database['batch'];

    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none',
      },
      representativeConsent: true,
      privacyConsent: true,
      ...policyProof,
    }, cryptoScope)).rejects.toThrow('patient intake storage failed');
  });

  it('does not misreport an unknown D1 failure as a revision conflict', async () => {
    const patient = {
      id: 'patient-1', line_account_id: 'account-1', owner_friend_id: 'friend-1',
      relationship: 'self', name: '患者', name_kana: 'カンジャ', birth_date: '2000-01-01',
      sex: null, contact_phone: null, archived_at: null,
    };
    const { db } = fakeDb([
      patient, null, policy, null, null,
      null, null, patient,
    ]);
    db.batch = vi.fn(async () => { throw new Error('D1 unavailable'); }) as D1Database['batch'];

    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none',
      },
      representativeConsent: true,
      privacyConsent: true,
      ...policyProof,
    }, cryptoScope)).rejects.toThrow('patient intake storage failed');
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
      ...policyProof,
    }, cryptoScope)).rejects.toThrow('intake consent required');
    expect(calls).toHaveLength(0);
  });

  it('rejects intake without a valid privacy policy proof before touching D1', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none',
      },
      representativeConsent: true,
      privacyConsent: true,
    } as never, cryptoScope)).rejects.toThrow('invalid privacy policy proof');
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-string privacy policy hash before touching D1', async () => {
    const { db, calls } = fakeDb(null);
    await expect(createPatientIntakeResponse(db, owner, 'patient-1', {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none',
      },
      representativeConsent: true,
      privacyConsent: true,
      privacyPolicyVersion: 1,
      privacyPolicyHash: ['a'.repeat(64)] as never,
    }, cryptoScope)).rejects.toThrow('invalid privacy policy proof');
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
      ...policyProof,
    }, cryptoScope)).rejects.toThrow('invalid intake answers');
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
      ...policyProof,
    }, cryptoScope)).rejects.toThrow('invalid intake answers');
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
      ...policyProof,
    }, cryptoScope)).rejects.toThrow('invalid intake answers');
    expect(calls).toHaveLength(0);
  });

  it('loads the newest intake revision within the owner scope', async () => {
    const { db, calls } = fakeDb({ id: 'response-2', revision: 2 });
    await expect(getLatestPatientIntake(db, owner, 'patient-1', cryptoScope)).resolves.toEqual({
      id: 'response-2', revision: 2,
    });
    expect(calls[0].sql).toContain('line_account_id = ? AND owner_friend_id = ?');
    expect(calls[0].values.slice(0, 4)).toEqual([
      'account-1', 'friend-1', 'patient-1', 'friend-1',
    ]);
    expect(calls[0].sql).toContain('pharmacy_patient_proxy_grants');
  });
});
