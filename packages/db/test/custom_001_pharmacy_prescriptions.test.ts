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

function insertSubmission(
  db: Database.Database,
  id: string,
  accountId: string,
  friendId: string,
  key: string,
  status = 'draft',
): void {
  db.prepare(
    `INSERT INTO pharmacy_prescription_submissions
       (id, line_account_id, friend_id, idempotency_key, status,
        upload_revision, requested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, '2026-08-17T00:00:00Z',
             '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`,
  ).run(id, accountId, friendId, key, status);
}

describe('custom_001_pharmacy_prescriptions.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    seedAccountAndFriend(db, 'account-a', 'friend-a');
    seedAccountAndFriend(db, 'account-b', 'friend-b');
  });

  it('creates the dedicated submission, file, and event tables', () => {
    const bootstrapMeta = JSON.parse(
      readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8'),
    ) as { includedMigrations: string[] };
    expect(bootstrapMeta.includedMigrations).toEqual([
      '001_v033_baseline.sql',
      '002_custom_060_messages_log_account_date.sql',
      '003_outbound_line_deliveries.sql',
      '004_custom_061_generic_resource_tenant_scope.sql',
      '005_custom_062_ref_tracking_tenant_scope.sql',
      '006_custom_063_auth_disable_revocation.sql',
      '007_custom_064_legacy_access_grant_drain.sql',
      '008_custom_065_session_rotation_family.sql',
    ]);
    const names = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN
         ('pharmacy_prescription_events','pharmacy_prescription_files','pharmacy_prescription_submissions')
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(names.map((row) => row.name)).toEqual([
      'pharmacy_prescription_events',
      'pharmacy_prescription_files',
      'pharmacy_prescription_submissions',
    ]);
  });

  it('enforces tenant-scoped idempotency while allowing the same key in another account', () => {
    insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'same-key');
    expect(() =>
      insertSubmission(db, 'submission-a2', 'account-a', 'friend-a', 'same-key'),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertSubmission(db, 'submission-b', 'account-b', 'friend-b', 'same-key'),
    ).not.toThrow();
  });

  it('rejects a friend from a different LINE account and invalid states', () => {
    expect(() =>
      insertSubmission(db, 'cross-account', 'account-a', 'friend-b', 'key'),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      insertSubmission(db, 'bad-status', 'account-a', 'friend-a', 'key', 'unknown'),
    ).toThrow(/CHECK constraint failed/);
  });

  it('keeps file positions and private R2 keys unique', () => {
    insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'key');
    const insert = db.prepare(
      `INSERT INTO pharmacy_prescription_files
         (id, submission_id, revision, position, r2_key, content_type,
          byte_size, sha256, state, created_at, updated_at)
       VALUES (?, 'submission-a', 1, ?, ?, 'image/png', 24, ?, 'ready',
               '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`,
    );
    insert.run('file-a', 1, 'custom/pharmacy/prescriptions/a/1/a', 'a'.repeat(64));
    expect(() =>
      insert.run('file-b', 1, 'custom/pharmacy/prescriptions/a/1/b', 'b'.repeat(64)),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insert.run('file-c', 2, 'custom/pharmacy/prescriptions/a/1/a', 'c'.repeat(64)),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects free-text audit categories and invalid reason codes', () => {
    insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'key');
    const insert = db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type,
          from_status, to_status, reason_code, created_at)
       VALUES (?, 'submission-a', 'staff', 'staff-a', ?, 'received',
               'needs_resubmission', ?, '2026-08-17T00:00:00Z')`,
    );
    expect(() => insert.run('event-a', 'free_text', 'blurred')).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert.run('event-b', 'status_changed', 'write-anything')).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('supports immutable notification failure and delivery audit events', () => {
    insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'key');
    const insert = db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type, to_status, created_at)
       VALUES (?, 'submission-a', 'system', 'status-event-a', ?, 'received',
               '2026-08-17T00:00:00Z')`,
    );
    expect(() => insert.run('failure-a', 'notification_failed')).not.toThrow();
    expect(() => insert.run('sent-a', 'notification_sent')).not.toThrow();
  });
});
