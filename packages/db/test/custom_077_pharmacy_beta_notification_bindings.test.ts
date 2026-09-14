import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-09-14T00:00:00.000Z';
const EXPIRES = '2027-09-14T00:00:00.000Z';

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active', '${NOW}', '${NOW}');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'Account A', 'token-a', 'secret-a', '${NOW}', '${NOW}');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
    VALUES ('tenant-a', 'account-a', '${NOW}', '${NOW}');
    INSERT INTO friends
      (id, line_user_id, line_account_id, provider_line_user_id, created_at, updated_at)
    VALUES ('friend-a', 'line-a', 'account-a', 'U-a', '${NOW}', '${NOW}');
    UPDATE pharmacy_account_capabilities
       SET capabilities_json = '["prescription_intake","continuity","medication_followup"]',
           beta_enabled = 1,
           updated_at = '${NOW}'
     WHERE line_account_id = 'account-a';
    INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana,
       birth_date, created_at, updated_at)
    VALUES ('patient-a', 'account-a', 'friend-a', 'self', 'Patient', '患者',
            '1990-01-01', '${NOW}', '${NOW}');
    INSERT INTO pharmacy_beta_memberships
      (id, line_account_id, participant_friend_id, subject_patient_id,
       subject_owner_friend_id, access_kind, status, starts_at, expires_at,
       version, created_at, updated_at)
    VALUES ('membership-old', 'account-a', 'friend-a', 'patient-a', 'friend-a',
            'self', 'active', '2026-01-01T00:00:00.000Z', '${EXPIRES}',
            1, '${NOW}', '${NOW}');
  `);
  return sqlite;
}

function insertSubmission(sqlite: Database.Database, id: string): void {
  sqlite.prepare(`
    INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status,
       active_revision, upload_revision, readiness_notice_consent_at,
       created_at, updated_at)
    VALUES (?, 'account-a', 'friend-a', ?, 'ready', 1, 1, ?, ?, ?)
  `).run(id, `idempotency-${id}`, NOW, NOW, NOW);
}

function insertPatientLink(sqlite: Database.Database, submissionId: string, createdAt = NOW): void {
  sqlite.prepare(`
    INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
    VALUES (?, 'account-a', 'friend-a', 'patient-a',
            (SELECT COALESCE(MAX(revision), 0) + 1
               FROM pharmacy_patient_intake_responses
              WHERE line_account_id = 'account-a' AND patient_id = 'patient-a'),
            2, '{}', '{}', ?, ?, ?, ?)
  `).run(`response-${submissionId}`, `response-idempotency-${submissionId}`, createdAt, createdAt, createdAt);
  sqlite.prepare(`
    INSERT INTO pharmacy_prescription_patients
      (submission_id, line_account_id, owner_friend_id, patient_id,
       intake_response_id, created_at)
    VALUES (?, 'account-a', 'friend-a', 'patient-a', ?, ?)
  `).run(submissionId, `response-${submissionId}`, createdAt);
}

function insertStatusEvent(sqlite: Database.Database, submissionId: string, eventId: string, createdAt = NOW): void {
  sqlite.prepare(`
    INSERT INTO pharmacy_prescription_events
      (id, submission_id, actor_type, actor_id, event_type,
       from_status, to_status, revision, created_at)
    VALUES (?, ?, 'staff', 'staff-a', 'status_changed', 'received', 'ready', 1, ?)
  `).run(eventId, submissionId, createdAt);
}

function insertValidity(sqlite: Database.Database, submissionId: string, validUntil = '2026-09-20'): void {
  sqlite.prepare(`
    INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, issued_on, valid_until, validity_basis,
       verification_status, verified_by, verified_at, reminder_due_at,
       created_at, updated_at)
    VALUES (?, 'account-a', '2026-09-01', ?,
            'prescriber_specified', 'verified', 'staff-a', ?, ?, ?, ?)
  `).run(submissionId, validUntil, NOW, '2026-09-19T00:00:00.000Z', NOW, NOW);
}

function binding(sqlite: Database.Database, retryKey: string): unknown {
  return sqlite.prepare(`
    SELECT line_account_id, retry_key, participant_friend_id, subject_patient_id,
           subject_owner_friend_id, membership_id
      FROM pharmacy_beta_notification_bindings
     WHERE line_account_id = 'account-a' AND retry_key = ?
  `).get(retryKey);
}

describe('custom_077 pharmacy beta notification bindings', () => {
  it('binds every patient notification source to the membership active at creation', () => {
    const sqlite = setup();
    insertSubmission(sqlite, 'submission-a');
    insertPatientLink(sqlite, 'submission-a');
    insertStatusEvent(sqlite, 'submission-a', 'status-event-a');

    sqlite.prepare(`
      INSERT INTO pharmacy_medication_followups
        (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, due_at, version, created_by, created_at, updated_at)
      VALUES ('followup-a', 'account-a', 'friend-a', 'patient-a', 'submission-a',
              'scheduled', ?, 1, 'staff-a', ?, ?)
    `).run(EXPIRES, NOW, NOW);

    sqlite.prepare(`
      INSERT INTO pharmacy_continuity_obligations
        (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, expected_next_from, expected_next_to, next_contact_at,
         consent_at, created_at, updated_at)
      VALUES ('obligation-a', 'account-a', 'friend-a', 'patient-a', 'submission-a',
              'active', '2026-10-01', '2026-10-31', ?, ?, ?, ?)
    `).run(EXPIRES, NOW, NOW, NOW);
    sqlite.prepare(`
      INSERT INTO pharmacy_next_intake_expectations
        (id, obligation_id, line_account_id, owner_friend_id, patient_id, status,
         timing_source, expected_from, expected_to, reminder_at, version,
         created_by, created_at, updated_at)
      VALUES ('expectation-a', 'obligation-a', 'account-a', 'friend-a', 'patient-a',
              'offered', 'manual_window', '2026-10-01', '2026-10-31', ?, 1,
              'staff-a', ?, ?)
    `).run(EXPIRES, NOW, NOW);

    insertValidity(sqlite, 'submission-a');

    expect(binding(sqlite, 'status-event-a')).toMatchObject({
      membership_id: 'membership-old',
      participant_friend_id: 'friend-a',
      subject_patient_id: 'patient-a',
    });
    expect(binding(sqlite, 'medication-followup:followup-a')).toMatchObject({
      membership_id: 'membership-old',
    });
    expect(binding(sqlite, 'next-intake:expectation-a')).toMatchObject({
      membership_id: 'membership-old',
    });
    expect(binding(sqlite, 'prescription-validity:submission-a:2026-09-20')).toMatchObject({
      membership_id: 'membership-old',
    });
  });

  it('binds a status event when patient linkage is added later and never backfills after regrant', () => {
    const sqlite = setup();
    insertSubmission(sqlite, 'submission-late');
    insertStatusEvent(sqlite, 'submission-late', 'status-event-late');
    insertSubmission(sqlite, 'submission-other');
    insertStatusEvent(sqlite, 'submission-other', 'status-event-other');
    expect(binding(sqlite, 'status-event-late')).toBeUndefined();
    expect(binding(sqlite, 'status-event-other')).toBeUndefined();

    insertPatientLink(sqlite, 'submission-late');
    expect(binding(sqlite, 'status-event-late')).toMatchObject({ membership_id: 'membership-old' });
    expect(binding(sqlite, 'status-event-other')).toBeUndefined();

    sqlite.prepare(`
      UPDATE pharmacy_beta_memberships
         SET status = 'revoked', revoked_at = ?, revoke_reason_code = 'test',
             version = 2, updated_at = ?
       WHERE id = 'membership-old'
    `).run(NOW, NOW);
    sqlite.prepare(`
      INSERT INTO pharmacy_beta_memberships
        (id, line_account_id, participant_friend_id, subject_patient_id,
         subject_owner_friend_id, access_kind, status, starts_at, expires_at,
         version, created_at, updated_at)
      VALUES ('membership-new', 'account-a', 'friend-a', 'patient-a', 'friend-a',
              'self', 'active', ?, ?, 1, ?, ?)
    `).run(NOW, EXPIRES, NOW, NOW);

    expect(binding(sqlite, 'status-event-late')).toMatchObject({ membership_id: 'membership-old' });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM pharmacy_beta_notification_bindings
       WHERE line_account_id = 'account-a' AND retry_key = 'status-event-late'
         AND membership_id = 'membership-new'
    `).get()).toEqual({ count: 0 });
  });

  it('does not bind a late patient link to a membership granted after the event', () => {
    const sqlite = setup();
    insertSubmission(sqlite, 'submission-late-grant');
    insertStatusEvent(sqlite, 'submission-late-grant', 'status-event-late-grant');
    sqlite.prepare(`
      UPDATE pharmacy_beta_memberships
         SET status = 'revoked', revoked_at = ?, revoke_reason_code = 'test',
             version = 2, updated_at = ?
       WHERE id = 'membership-old'
    `).run(NOW, NOW);
    sqlite.prepare(`
      INSERT INTO pharmacy_beta_memberships
        (id, line_account_id, participant_friend_id, subject_patient_id,
         subject_owner_friend_id, access_kind, status, starts_at, expires_at,
         version, created_at, updated_at)
      VALUES ('membership-later', 'account-a', 'friend-a', 'patient-a', 'friend-a',
              'self', 'active', '2026-09-14T01:00:00.000Z', ?, 1, ?, ?)
    `).run(EXPIRES, NOW, NOW);

    insertPatientLink(sqlite, 'submission-late-grant', '2026-09-14T02:00:00.000Z');

    expect(binding(sqlite, 'status-event-late-grant')).toBeUndefined();
  });

  it('keeps a source created during suspension bound to the same membership', () => {
    const sqlite = setup();
    sqlite.prepare(`
      UPDATE pharmacy_beta_memberships
         SET status = 'suspended', version = 2, updated_at = ?
       WHERE id = 'membership-old'
    `).run(NOW);
    insertSubmission(sqlite, 'submission-suspended');
    insertPatientLink(sqlite, 'submission-suspended');
    insertStatusEvent(sqlite, 'submission-suspended', 'status-event-suspended');

    expect(binding(sqlite, 'status-event-suspended')).toMatchObject({ membership_id: 'membership-old' });
  });

  it('does not backfill a source created while beta is disabled and protects bindings from mutation', () => {
    const sqlite = setup();
    sqlite.prepare(`UPDATE pharmacy_account_capabilities SET beta_enabled = 0 WHERE line_account_id = 'account-a'`).run();
    insertSubmission(sqlite, 'submission-disabled');
    insertPatientLink(sqlite, 'submission-disabled');
    insertStatusEvent(sqlite, 'submission-disabled', 'status-event-disabled');
    insertValidity(sqlite, 'submission-disabled');
    expect(binding(sqlite, 'status-event-disabled')).toBeUndefined();
    expect(binding(sqlite, 'prescription-validity:submission-disabled:2026-09-20')).toBeUndefined();
    sqlite.prepare(`
      UPDATE pharmacy_prescription_validities
         SET valid_until = '2026-09-21', updated_at = ?
       WHERE submission_id = 'submission-disabled' AND line_account_id = 'account-a'
    `).run(NOW);
    expect(binding(sqlite, 'prescription-validity:submission-disabled:2026-09-21')).toBeUndefined();

    sqlite.prepare(`UPDATE pharmacy_account_capabilities SET beta_enabled = 1 WHERE line_account_id = 'account-a'`).run();
    expect(binding(sqlite, 'status-event-disabled')).toBeUndefined();

    insertSubmission(sqlite, 'submission-protected');
    insertPatientLink(sqlite, 'submission-protected');
    insertStatusEvent(sqlite, 'submission-protected', 'status-event-protected');
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_beta_notification_bindings
         SET membership_id = 'membership-old'
       WHERE line_account_id = 'account-a' AND retry_key = 'status-event-protected'
    `).run()).toThrow(/PHARMACY_BETA_NOTIFICATION_BINDING_IMMUTABLE/);
    expect(() => sqlite.prepare(`
      DELETE FROM pharmacy_beta_notification_bindings
       WHERE line_account_id = 'account-a' AND retry_key = 'status-event-protected'
    `).run()).toThrow(/PHARMACY_BETA_NOTIFICATION_BINDING_IMMUTABLE/);
  });
});
