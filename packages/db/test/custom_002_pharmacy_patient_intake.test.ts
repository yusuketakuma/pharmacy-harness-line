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

function seedAccountAndFriend(db: Database.Database, accountId: string, friendId: string): void {
  db.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
     VALUES (?, ?, ?, 'token', 'secret', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`,
  ).run(accountId, 'channel-' + accountId, accountId);
  db.prepare(
    `INSERT INTO friends
       (id, line_user_id, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`,
  ).run(friendId, 'line-' + friendId, accountId);
}

function insertPatient(
  db: Database.Database,
  id: string,
  accountId: string,
  friendId: string,
  relationship = 'self',
): void {
  db.prepare(
    `INSERT INTO pharmacy_patients
       (id, line_account_id, owner_friend_id, relationship, name, name_kana,
        birth_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, '患者', 'カンジャ', '2000-01-01', ?, ?)`,
  ).run(id, accountId, friendId, relationship, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');
}

describe('custom_002_pharmacy_patient_intake.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    seedAccountAndFriend(db, 'account-a', 'friend-a');
    seedAccountAndFriend(db, 'account-b', 'friend-b');
  });

  it('creates family patient, intake revision, and prescription link tables', () => {
    const names = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'pharmacy_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;

    expect(names.map((row) => row.name)).toEqual(expect.arrayContaining([
      'pharmacy_patients',
      'pharmacy_patient_intake_responses',
      'pharmacy_prescription_patients',
    ]));
    const column = db.prepare(
      `PRAGMA table_info(pharmacy_prescription_submissions)`,
    ).all() as Array<{ name: string; dflt_value: string | null }>;
    expect(column.find((row) => row.name === 'intake_required')?.dflt_value).toBe('0');
  });

  it('allows one self and multiple family patients but rejects a second active self', () => {
    insertPatient(db, 'patient-self', 'account-a', 'friend-a');
    expect(() => insertPatient(db, 'patient-self-2', 'account-a', 'friend-a')).toThrow(/UNIQUE constraint failed/);
    expect(() => insertPatient(db, 'patient-child', 'account-a', 'friend-a', 'child')).not.toThrow();
  });

  it('enforces patient ownership across LINE accounts', () => {
    expect(() => insertPatient(db, 'cross-account', 'account-a', 'friend-b')).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('enforces intake answer JSON and bounded idempotency keys', () => {
    insertPatient(db, 'patient-self', 'account-a', 'friend-a');
    const insert = db.prepare(
      `INSERT INTO pharmacy_patient_intake_responses
         (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
          patient_snapshot_json, answers_json, idempotency_key,
          representative_consent_at, privacy_consent_at, created_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insert.run(
      'response-a', 'account-a', 'friend-a', 'patient-self',
      '{"name":"患者"}', '{"allergies":"none"}', 'valid-key',
      '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z',
    )).not.toThrow();
    expect(() => insert.run(
      'response-b', 'account-a', 'friend-a', 'patient-self',
      'not-json', '{"allergies":"none"}', 'valid-key-2',
      '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z',
    )).toThrow(/CHECK constraint failed/);
  });

  it('prevents cross-family prescription links', () => {
    insertPatient(db, 'patient-self', 'account-a', 'friend-a');
    const response = db.prepare(
      `INSERT INTO pharmacy_patient_intake_responses
         (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
          patient_snapshot_json, answers_json, idempotency_key,
          representative_consent_at, privacy_consent_at, created_at)
       VALUES ('response-a', 'account-a', 'friend-a', 'patient-self', 1, 1,
               '{"name":"患者"}', '{"allergies":"none"}', 'valid-key',
               '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`,
    );
    response.run();
    expect(() => db.prepare(
      `INSERT INTO pharmacy_prescription_patients
         (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
       VALUES ('missing-submission', 'account-a', 'friend-a', 'patient-self', 'response-a', '2026-08-17T00:00:00Z')`,
    ).run()).toThrow(/FOREIGN KEY constraint failed/);
  });
});
