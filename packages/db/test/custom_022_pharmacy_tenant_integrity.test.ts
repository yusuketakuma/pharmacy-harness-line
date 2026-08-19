import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.exec(`
    INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'active', '2026-08-19', '2026-08-19'),
           ('tenant-b', 'tenant-b', 'Tenant B', 'active', '2026-08-19', '2026-08-19');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'Account A', 'token-a', 'secret-a', '2026-08-19', '2026-08-19'),
           ('account-b', 'channel-b', 'Account B', 'token-b', 'secret-b', '2026-08-19', '2026-08-19');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
    VALUES ('tenant-a', 'account-a', '2026-08-19', '2026-08-19'),
           ('tenant-b', 'account-b', '2026-08-19', '2026-08-19');
    INSERT INTO staff_members
      (id, name, role, api_key, created_at, updated_at)
    VALUES ('staff-a', 'Staff A', 'staff', 'key-a', '2026-08-19', '2026-08-19'),
           ('staff-b', 'Staff B', 'staff', 'key-b', '2026-08-19', '2026-08-19');
    INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES ('tenant-a', 'staff-a', 'staff', 1, '2026-08-19', '2026-08-19'),
           ('tenant-b', 'staff-b', 'staff', 1, '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES ('account-a', 'staff-a', 1, '2026-08-19', '2026-08-19');
  `);
  return db;
}

function applyMigration(db: Database.Database): void {
  db.exec(readFileSync(
    join(ROOT, 'migrations', 'custom_022_pharmacy_tenant_integrity.sql'),
    'utf8',
  ));
}

function seedPharmacyRows(db: Database.Database): void {
  db.exec(`
    INSERT INTO friends
      (id, line_user_id, line_account_id, created_at, updated_at)
    VALUES ('friend-a', 'line-user-a', 'account-a', '2026-08-19', '2026-08-19'),
           ('friend-b', 'line-user-b', 'account-b', '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana,
       birth_date, created_at, updated_at)
    VALUES ('patient-a', 'account-a', 'friend-a', 'self', 'Patient A', 'PATIENT A',
            '2000-01-01', '2026-08-19', '2026-08-19'),
           ('patient-b', 'account-b', 'friend-b', 'self', 'Patient B', 'PATIENT B',
            '2000-01-02', '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
       created_at, updated_at)
    VALUES ('submission-a', 'account-a', 'friend-a', 'submission-a-key', 'closed', 1,
            '2026-08-19', '2026-08-19'),
           ('submission-b', 'account-b', 'friend-b', 'submission-b-key', 'closed', 1,
            '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
    VALUES ('response-a', 'account-a', 'friend-a', 'patient-a', 1, 1,
            '{"name":"Patient A"}', '{"allergiesStatus":"none"}', 'response-a-key',
            '2026-08-19', '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_continuity_obligations
      (id, line_account_id, owner_friend_id, patient_id, source_submission_id, status,
       expected_next_from, expected_next_to, next_contact_at, consent_at,
       created_at, updated_at)
    VALUES ('obligation-a', 'account-a', 'friend-a', 'patient-a', 'submission-a', 'active',
            '2026-09-01', '2026-10-31', '2026-09-01', '2026-08-19',
            '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, patient_id, method, status, source,
       correlation_id, expires_at, created_at, updated_at)
    VALUES ('handoff-b', 'account-b', 'friend-b', 'patient-b', 'PAPER', 'CREATED', 'LIFF',
            'correlation-b', '2026-09-01', '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_prescription_expectations
      (id, line_account_id, friend_id, patient_id, handoff_id, method,
       receipt_status, created_at, updated_at)
    VALUES ('expectation-b', 'account-b', 'friend-b', 'patient-b', 'handoff-b', 'PAPER',
            'EXPECTED', '2026-08-19', '2026-08-19');
  `);
}

describe('custom_022_pharmacy_tenant_integrity.sql', () => {
  it('rejects account assignments that cross tenant staff membership', () => {
    const db = database();
    applyMigration(db);

    expect(() => db.prepare(`INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
      VALUES ('account-a', 'staff-b', 1, '2026-08-19', '2026-08-19')`).run())
      .toThrow(/PHARMACY_STAFF_TENANT_MISMATCH/);
    expect(() => db.prepare(`UPDATE pharmacy_staff_accounts
      SET staff_id = 'staff-b' WHERE line_account_id = 'account-a' AND staff_id = 'staff-a'`).run())
      .toThrow(/PHARMACY_STAFF_TENANT_MISMATCH/);
    expect(db.prepare(`SELECT line_account_id, staff_id FROM pharmacy_staff_accounts`).all())
      .toEqual([{ line_account_id: 'account-a', staff_id: 'staff-a' }]);
  });

  it('rejects cross-tenant legacy pharmacy references', () => {
    const db = database();
    seedPharmacyRows(db);
    applyMigration(db);

    expect(() => db.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, base_response_id, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
      VALUES ('response-b', 'account-b', 'friend-b', 'patient-b', 1, 1,
        '{"name":"Patient B"}', '{"allergiesStatus":"none"}', 'response-a',
        'response-b-key', '2026-08-19', '2026-08-19', '2026-08-19')`).run())
      .toThrow(/PHARMACY_INTAKE_BASE_SCOPE_MISMATCH/);

    expect(() => db.prepare(`INSERT INTO pharmacy_continuity_events
      (id, obligation_id, line_account_id, event_type, submission_id, actor_type, created_at)
      VALUES ('event-a', 'obligation-a', 'account-a', 'linked', 'submission-b', 'system', '2026-08-19')`).run())
      .toThrow(/PHARMACY_CONTINUITY_SUBMISSION_SCOPE_MISMATCH/);

    expect(() => db.prepare(`INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, patient_id, expectation_id, method, status, source,
       correlation_id, expires_at, created_at, updated_at)
      VALUES ('handoff-a', 'account-a', 'friend-a', 'patient-a', 'expectation-b', 'PAPER',
        'CREATED', 'LIFF', 'correlation-a', '2026-09-01', '2026-08-19', '2026-08-19')`).run())
      .toThrow(/PHARMACY_MYNA_EXPECTATION_SCOPE_MISMATCH/);
  });

  it('is safe to apply repeatedly after the initial tenant schema', () => {
    const db = database();
    const migration = readFileSync(
      join(ROOT, 'migrations', 'custom_022_pharmacy_tenant_integrity.sql'),
      'utf8',
    );

    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
  });
});
