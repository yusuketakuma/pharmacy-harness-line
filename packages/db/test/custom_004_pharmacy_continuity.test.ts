import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

function seed(db: Database.Database): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', '薬局', 'token', 'secret', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
  db.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, created_at, updated_at)
    VALUES ('friend-a', 'line-friend-a', 'account-a', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date, created_at, updated_at)
    VALUES ('patient-a', 'account-a', 'friend-a', 'self', '患者', 'カンジャ', '2000-01-01', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
  db.prepare(`INSERT INTO pharmacy_prescription_submissions
    (id, line_account_id, friend_id, idempotency_key, status, upload_revision, created_at, updated_at)
    VALUES ('submission-a', 'account-a', 'friend-a', 'request-a', 'closed', 1, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
  db.prepare(`INSERT INTO pharmacy_patient_intake_responses
    (id, line_account_id, owner_friend_id, patient_id, revision, schema_version, patient_snapshot_json, answers_json, idempotency_key, representative_consent_at, privacy_consent_at, created_at)
    VALUES ('response-a', 'account-a', 'friend-a', 'patient-a', 1, 1, '{"name":"患者"}', '{"allergiesStatus":"none","adverseReactionStatus":"none"}', 'intake-a', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
  db.prepare(`INSERT INTO pharmacy_prescription_patients
    (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
    VALUES ('submission-a', 'account-a', 'friend-a', 'patient-a', 'response-a', '2026-08-17T00:00:00Z')`).run();
}

describe('custom_004_pharmacy_continuity.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    seed(db);
  });

  it('allows one open continuity record per patient and keeps events append-only', () => {
    db.prepare(`INSERT INTO pharmacy_continuity_obligations
      (id, line_account_id, owner_friend_id, patient_id, source_submission_id, status,
       expected_next_from, expected_next_to, next_contact_at, consent_at, created_at, updated_at)
      VALUES ('obligation-a', 'account-a', 'friend-a', 'patient-a', 'submission-a', 'active',
        '2026-09-01', '2026-10-31', '2026-09-01', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
    db.prepare(`INSERT INTO pharmacy_continuity_events
      (id, obligation_id, line_account_id, event_type, actor_type, created_at)
      VALUES ('event-a', 'obligation-a', 'account-a', 'opened', 'system', '2026-08-17T00:00:00Z')`).run();
    expect(() => db.prepare(`INSERT INTO pharmacy_continuity_obligations
      (id, line_account_id, owner_friend_id, patient_id, source_submission_id, status,
       expected_next_from, expected_next_to, next_contact_at, consent_at, created_at, updated_at)
      VALUES ('obligation-b', 'account-a', 'friend-a', 'patient-a', 'submission-a', 'active',
        '2026-09-01', '2026-10-31', '2026-09-01', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run()).toThrow(/UNIQUE constraint failed/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM pharmacy_continuity_events').get()).toEqual({ count: 1 });
  });

  it('keeps tenant and patient foreign keys enforced', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_continuity_obligations
      (id, line_account_id, owner_friend_id, patient_id, source_submission_id, status,
       expected_next_from, expected_next_to, next_contact_at, consent_at, created_at, updated_at)
      VALUES ('obligation-x', 'other-account', 'friend-a', 'patient-a', 'submission-a', 'active',
        '2026-09-01', '2026-10-31', '2026-09-01', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run()).toThrow(/FOREIGN KEY constraint failed/);
  });
});
