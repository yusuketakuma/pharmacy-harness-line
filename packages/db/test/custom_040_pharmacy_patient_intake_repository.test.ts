import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archivePharmacyPatient,
  createPatientIntakeResponse,
  getPharmacyPatient,
  getPatientAccessState,
  getLatestPatientIntake,
  listPharmacyPatients,
  setPatientNotificationPreference,
  setPatientPrivacyConsent,
  updatePharmacyPatient,
  type CreatePatientIntakeInput,
} from '../../../apps/worker/src/custom/pharmacy/intake/repository.js';
import { INVALID_PATIENT_INTAKE_ENVELOPE_ERROR } from '../../../apps/worker/src/custom/pharmacy/intake/encryption.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-20T00:00:00.000Z';
const owner = { lineAccountId: 'account-a', friendId: 'friend-a' };
const cryptoScope = {
  tenantId: 'tenant-a',
  rootSecret: 'synthetic-pharmacy-phi-root-secret-v1',
};

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };
function d1From(sqlite: Database.Database, failAt?: number): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item, index) => {
        if (index === failAt) throw new Error('synthetic D1 failure');
        return (item as RunnableStatement).runSync() as D1Result<T>;
      }),
    )(),
  } as unknown as D1Database;
}

const input: CreatePatientIntakeInput = {
  idempotencyKey: 'intake-key-001',
  answers: {
    allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
    medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
    smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none', notes: 'synthetic',
  },
  representativeConsent: true,
  privacyConsent: true,
  privacyPolicyVersion: 1,
  privacyPolicyHash: 'a'.repeat(64),
};

function seed(db: Database.Database): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', '薬局A', 'token-a', 'secret-a', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES ('tenant-a', 'pharmacy-a', '薬局A', 'active', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES ('tenant-a', 'account-a', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES ('staff-a', 'Staff A', 'admin', 'key-a', 1, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES ('tenant-a', 'staff-a', 'admin', 1, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES ('account-a', 'staff-a', 1, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_tenant_privacy_policy
    (line_account_id, purpose_text, purpose_url, contact_point, entrustment_text,
     policy_version, content_hash, updated_by, created_at, updated_at)
    VALUES ('account-a', '調剤と連絡', '', '薬局窓口', '運営委託あり',
            1, ?, 'staff-a', ?, ?)`).run('a'.repeat(64), NOW, NOW);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES ('friend-a', 'U-a', 'account-a', 1, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES ('patient-a', 'account-a', 'friend-a', 'self', '患者A', 'カンジャエー',
            '1990-01-01', ?, ?)`).run(NOW, NOW);
}

function insertFamilyPatient(db: Database.Database): void {
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES ('patient-family', 'account-a', 'friend-a', 'child', '患者B', 'カンジャビー',
            '2018-01-01', ?, ?)`).run(NOW, NOW);
}

function insertActiveProxyGrant(db: Database.Database): void {
  db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
    (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
     terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
    VALUES ('grant-a', 'account-a', 'patient-family', 'friend-a', 'patient_intake_v1',
            'self_attested', 1, ?, '2026-09-01T00:00:00.000Z',
            '2099-01-01T00:00:00.000Z', 1, ?, ?)`).run('a'.repeat(64), NOW, NOW);
}

describe('encrypted pharmacy patient intake repository', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seed(sqlite);
    db = d1From(sqlite);
  });

  it('atomically writes both envelopes and prefers them over changed legacy plaintext', async () => {
    const created = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    expect(sqlite.prepare(`SELECT field_name FROM pharmacy_patient_intake_envelopes
      WHERE response_id = ? ORDER BY field_name`).all(created.id)).toEqual([
      { field_name: 'answers_json' }, { field_name: 'patient_snapshot_json' },
    ]);
    sqlite.prepare(`UPDATE pharmacy_patient_intake_responses
      SET answers_json = '{"allergiesStatus":"yes"}', patient_snapshot_json = '{"name":"legacy changed"}'
      WHERE id = ?`).run(created.id);

    const latest = await getLatestPatientIntake(db, owner, 'patient-a', cryptoScope);
    expect(latest?.answers_json).toBe(JSON.stringify(input.answers));
    expect(latest?.patient_snapshot_json).toContain('患者A');
    expect(latest?.patient_snapshot_json).not.toContain('legacy changed');
  });

  it('rolls back the response when either envelope insert fails', async () => {
    await expect(createPatientIntakeResponse(
      d1From(sqlite, 2), owner, 'patient-a', input, cryptoScope,
    )).rejects.toThrow('patient intake storage failed');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_responses`).get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_envelopes`).get())
      .toEqual({ count: 0 });
  });

  it('stores only valid JSON sentinels after scrub and blocks writes while frozen', async () => {
    const insertState = (phase: 'frozen' | 'scrubbed' | 'restored') => sqlite.prepare(`
      INSERT INTO pharmacy_patient_intake_migration_state
        (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
         approved_by, approval_reference, approved_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, 0, ?, 'security-owner', 'TICKET-123', ?, ?)
    `).run(phase, 'a'.repeat(64), NOW, NOW);

    insertState('frozen');
    await expect(createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope))
      .rejects.toThrow('patient intake storage failed');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_responses`).get())
      .toEqual({ count: 0 });

    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_migration_state`).run();
    insertState('restored');
    await expect(createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope))
      .rejects.toThrow('patient intake storage failed');
    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_migration_state`).run();
    insertState('scrubbed');
    const created = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    expect(sqlite.prepare(`SELECT patient_snapshot_json, answers_json
      FROM pharmacy_patient_intake_responses WHERE id = ?`).get(created.id)).toEqual({
      patient_snapshot_json: '{}', answers_json: '{}',
    });
    await expect(getLatestPatientIntake(db, owner, 'patient-a', cryptoScope))
      .resolves.toMatchObject({ answers_json: JSON.stringify(input.answers) });
  });

  it('fails closed for a partial or tampered envelope without plaintext fallback', async () => {
    const created = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_envelopes
      WHERE response_id = ? AND field_name = 'patient_snapshot_json'`).run(created.id);
    await expect(getLatestPatientIntake(db, owner, 'patient-a', cryptoScope))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);

    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_responses`).run();
    const recreated = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    sqlite.prepare(`UPDATE pharmacy_patient_intake_envelopes SET ciphertext = ?
      WHERE response_id = ? AND field_name = 'answers_json'`).run('BBBBBBBBBBBBBBBBBBBBBB', recreated.id);
    await expect(getLatestPatientIntake(db, owner, 'patient-a', cryptoScope))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
  });

  it('reads a legacy row only when no envelope exists and keeps retries idempotent', async () => {
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
      VALUES ('legacy-a', 'account-a', 'friend-a', 'patient-a', 1, 2,
              '{"name":"legacy"}', '{"allergiesStatus":"none"}',
              'legacy-key-001', ?, ?, ?)`).run(NOW, NOW, NOW);
    await expect(getLatestPatientIntake(db, owner, 'patient-a', cryptoScope))
      .resolves.toMatchObject({ id: 'legacy-a', answers_json: '{"allergiesStatus":"none"}' });

    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_migration_state
      (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
       approved_by, approval_reference, approved_at, updated_at)
      VALUES ('tenant-a', 'account-a', 'frozen', 1, ?, 'security-owner', 'TICKET-123', ?, ?)`)
      .run('a'.repeat(64), NOW, NOW);
    await expect(getLatestPatientIntake(db, owner, 'patient-a', cryptoScope))
      .rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_migration_state`).run();

    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_responses`).run();
    const first = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    sqlite.prepare(`UPDATE pharmacy_tenant_privacy_policy
      SET policy_version = 2, content_hash = ? WHERE line_account_id = 'account-a'`)
      .run('b'.repeat(64));
    const second = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    expect(second.id).toBe(first.id);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_responses`).get())
      .toEqual({ count: 1 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_envelopes`).get())
      .toEqual({ count: 2 });
  });

  it('binds the tenant into AAD and rejects an archived patient write', async () => {
    await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    await expect(getLatestPatientIntake(db, owner, 'patient-a', {
      ...cryptoScope, tenantId: 'tenant-b',
    })).rejects.toThrow(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);

    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_responses`).run();
    sqlite.prepare(`UPDATE pharmacy_patients SET archived_at = ? WHERE id = 'patient-a'`).run(NOW);
    await expect(createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope))
      .rejects.toThrow('patient not found');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_responses`).get())
      .toEqual({ count: 0 });
  });

  it('does not treat a family relationship as patient authority', async () => {
    insertFamilyPatient(sqlite);

    await expect(listPharmacyPatients(db, owner)).resolves.toHaveLength(1);
    await expect(getPharmacyPatient(db, owner, 'patient-family')).resolves.toBeNull();
    sqlite.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('expired-a', 'account-a', 'patient-family', 'friend-a', 'patient_intake_v1',
              'self_attested', 1, ?, '2026-09-01T00:00:00.000Z',
              '2026-09-01T00:00:01.000Z', 1, ?, ?)`).run('a'.repeat(64), NOW, NOW);
    await expect(getPharmacyPatient(db, owner, 'patient-family')).resolves.toBeNull();
    await expect(createPatientIntakeResponse(db, owner, 'patient-family', input, cryptoScope))
      .rejects.toThrow('patient not found');
    await expect(updatePharmacyPatient(db, owner, 'patient-family', NOW, {
      relationship: 'child', name: '患者B', nameKana: 'カンジャビー', birthDate: '2018-01-01',
      sex: null, contactPhone: null, postalCode: null, prefecture: null, city: null,
      addressLine1: null, addressLine2: null,
    })).rejects.toThrow('patient update conflict');
    await expect(archivePharmacyPatient(db, owner, 'patient-family', NOW))
      .rejects.toThrow('patient archive conflict');
  });

  it('allows only an active patient_intake_v1 grant and records it on intake', async () => {
    insertFamilyPatient(sqlite);
    insertActiveProxyGrant(sqlite);

    await expect(getPharmacyPatient(db, owner, 'patient-family'))
      .resolves.toMatchObject({ id: 'patient-family', relationship: 'child' });
    await expect(getPatientAccessState(db, owner, 'patient-family')).resolves.toEqual({
      access: 'proxy', permission: 'patient_intake_v1',
      proxyExpiresAt: '2099-01-01T00:00:00.000Z', privacy: 'active',
      notifications: 'enabled', controlVersion: 0,
    });
    const created = await createPatientIntakeResponse(
      db, owner, 'patient-family', input, cryptoScope,
    );
    expect(sqlite.prepare(`SELECT proxy_grant_id FROM pharmacy_patient_intake_responses
      WHERE id = ?`).get(created.id)).toEqual({ proxy_grant_id: 'grant-a' });

    sqlite.prepare(`UPDATE pharmacy_patient_proxy_grants
      SET revoked_at = ?, revoke_reason_code = 'owner_revoked', version = version + 1, updated_at = ?
      WHERE id = 'grant-a'`).run(NOW, NOW);

    await expect(getPharmacyPatient(db, owner, 'patient-family')).resolves.toBeNull();
    await expect(getLatestPatientIntake(db, owner, 'patient-family', cryptoScope))
      .resolves.toBeNull();
    await expect(createPatientIntakeResponse(db, owner, 'patient-family', input, cryptoScope))
      .rejects.toThrow('patient not found');
  });

  it('keeps historical intake readable but blocks a new revision after privacy withdrawal', async () => {
    const created = await createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope);
    sqlite.prepare(`INSERT INTO pharmacy_patient_owner_controls
      (line_account_id, patient_id, owner_friend_id, privacy_withdrawn_at, version, updated_at)
      VALUES ('account-a', 'patient-a', 'friend-a', ?, 1, ?)`).run(NOW, NOW);

    await expect(getLatestPatientIntake(db, owner, 'patient-a', cryptoScope))
      .resolves.toMatchObject({ id: created.id });
    await expect(createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope))
      .resolves.toMatchObject({ id: created.id });
    await expect(createPatientIntakeResponse(db, owner, 'patient-a', {
      ...input, idempotencyKey: 'intake-key-002',
    }, cryptoScope)).rejects.toThrow('privacy consent withdrawn');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_responses`).get())
      .toEqual({ count: 1 });
  });

  it('hides a suspended binding without invalidating the LINE identity', async () => {
    sqlite.prepare(`INSERT INTO pharmacy_patient_owner_controls
      (line_account_id, patient_id, owner_friend_id, binding_suspended_at,
       binding_reason_code, version, updated_at)
      VALUES ('account-a', 'patient-a', 'friend-a', ?, 'wrong_binding', 1, ?)`).run(NOW, NOW);

    await expect(listPharmacyPatients(db, owner)).resolves.toEqual([]);
    await expect(getPharmacyPatient(db, owner, 'patient-a')).resolves.toBeNull();
    await expect(createPatientIntakeResponse(db, owner, 'patient-a', input, cryptoScope))
      .rejects.toThrow('patient not found');
  });

  it('changes privacy consent with CAS and an atomic PHI-free audit', async () => {
    await expect(getPatientAccessState(db, owner, 'patient-a')).resolves.toEqual({
      access: 'self', permission: null, proxyExpiresAt: null,
      privacy: 'active', notifications: 'enabled', controlVersion: 0,
    });
    await expect(setPatientPrivacyConsent(db, owner, 'patient-a', {
      action: 'withdraw', expectedControlVersion: 0,
    })).resolves.toEqual({ status: 'withdrawn', version: 1 });
    expect(sqlite.prepare(`SELECT privacy_withdrawn_at, privacy_reconsented_at, version
      FROM pharmacy_patient_owner_controls WHERE patient_id = 'patient-a'`).get())
      .toMatchObject({ privacy_withdrawn_at: expect.any(String), privacy_reconsented_at: null, version: 1 });
    await expect(getPatientAccessState(db, owner, 'patient-a')).resolves.toMatchObject({
      privacy: 'withdrawn', controlVersion: 1,
    });

    await expect(setPatientPrivacyConsent(db, owner, 'patient-a', {
      action: 'reconsent', expectedControlVersion: 1,
      privacyPolicyVersion: 1, privacyPolicyHash: 'a'.repeat(64),
    })).resolves.toEqual({ status: 'reconsented', version: 2 });
    expect(sqlite.prepare(`SELECT privacy_reconsented_at, privacy_policy_version,
      privacy_policy_hash, version FROM pharmacy_patient_owner_controls
      WHERE patient_id = 'patient-a'`).get()).toMatchObject({
      privacy_reconsented_at: expect.any(String), privacy_policy_version: 1,
      privacy_policy_hash: 'a'.repeat(64), version: 2,
    });
    expect(sqlite.prepare(`SELECT actor_kind, actor_id, action, control_version
      FROM pharmacy_patient_control_audit_events ORDER BY control_version`).all()).toEqual([
      { actor_kind: 'patient', actor_id: 'friend-a', action: 'privacy_withdrawn', control_version: 1 },
      { actor_kind: 'patient', actor_id: 'friend-a', action: 'privacy_reconsented', control_version: 2 },
    ]);

    await expect(setPatientPrivacyConsent(db, owner, 'patient-a', {
      action: 'withdraw', expectedControlVersion: 1,
    })).rejects.toThrow('patient consent conflict');
    await expect(setPatientPrivacyConsent(db, owner, 'missing-patient', {
      action: 'withdraw', expectedControlVersion: 0,
    })).rejects.toThrow('patient not found');
    expect(sqlite.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_patient_control_audit_events`).get()).toEqual({ count: 2 });
  });

  it('changes notification preference with CAS without reviving other authority', async () => {
    await setPatientPrivacyConsent(db, owner, 'patient-a', {
      action: 'withdraw', expectedControlVersion: 0,
    });
    await expect(setPatientNotificationPreference(db, owner, 'patient-a', {
      action: 'stop', expectedControlVersion: 1,
    })).resolves.toEqual({ status: 'stopped', version: 2 });
    await expect(getPatientAccessState(db, owner, 'patient-a')).resolves.toMatchObject({
      privacy: 'withdrawn', notifications: 'stopped', controlVersion: 2,
    });

    await expect(setPatientNotificationPreference(db, owner, 'patient-a', {
      action: 'resume', expectedControlVersion: 2,
    })).resolves.toEqual({ status: 'resumed', version: 3 });
    await expect(getPatientAccessState(db, owner, 'patient-a')).resolves.toMatchObject({
      privacy: 'withdrawn', notifications: 'enabled', controlVersion: 3,
    });
    expect(sqlite.prepare(`SELECT action, control_version
      FROM pharmacy_patient_control_audit_events ORDER BY control_version`).all()).toEqual([
      { action: 'privacy_withdrawn', control_version: 1 },
      { action: 'notifications_stopped', control_version: 2 },
      { action: 'notifications_resumed', control_version: 3 },
    ]);
    await expect(setPatientNotificationPreference(db, owner, 'patient-a', {
      action: 'stop', expectedControlVersion: 1,
    })).rejects.toThrow('patient notification conflict');
  });
});
