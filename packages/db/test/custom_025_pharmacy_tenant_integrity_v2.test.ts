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
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'Account A', 'token-a', 'secret-a', '2026-08-19', '2026-08-19'),
           ('account-b', 'channel-b', 'Account B', 'token-b', 'secret-b', '2026-08-19', '2026-08-19');
    INSERT INTO friends
      (id, line_user_id, line_account_id, created_at, updated_at)
    VALUES ('friend-a', 'line-user-a', 'account-a', '2026-08-19', '2026-08-19'),
           ('friend-b', 'line-user-b', 'account-b', '2026-08-19', '2026-08-19');
    INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, method, status, source, correlation_id, expires_at, created_at, updated_at)
    VALUES ('handoff-a', 'account-a', 'friend-a', 'PAPER', 'CREATED', 'LIFF', 'correlation-a', '2026-09-01', '2026-08-19', '2026-08-19'),
           ('handoff-b', 'account-b', 'friend-b', 'PAPER', 'CREATED', 'LIFF', 'correlation-b', '2026-09-01', '2026-08-19', '2026-08-19');
  `);
  return db;
}

function insertSubmission(
  db: Database.Database,
  id: string,
  accountId: string,
  friendId: string,
  sourceHandoffId: string | null,
): void {
  db.prepare(`INSERT INTO pharmacy_prescription_submissions
    (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
     source_handoff_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', 1, ?, '2026-08-19', '2026-08-19')`)
    .run(id, accountId, friendId, `${id}-key`, sourceHandoffId);
}

describe('custom_025_pharmacy_tenant_integrity_v2.sql', () => {
  it('rejects a submission whose source_handoff_id points at a different account handoff', () => {
    const db = database();

    expect(() => insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'handoff-b'))
      .toThrow(/PHARMACY_SUBMISSION_SOURCE_HANDOFF_SCOPE_MISMATCH/);
    expect(db.prepare(`SELECT id FROM pharmacy_prescription_submissions`).all()).toEqual([]);
  });

  it('allows a submission whose source_handoff_id points at its own account handoff', () => {
    const db = database();

    expect(() => insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'handoff-a'))
      .not.toThrow();
    expect(() => insertSubmission(db, 'submission-b', 'account-a', 'friend-a', null))
      .not.toThrow();
    expect(db.prepare(`SELECT id FROM pharmacy_prescription_submissions ORDER BY id`).all())
      .toEqual([{ id: 'submission-a' }, { id: 'submission-b' }]);
  });

  it('rejects re-pointing an existing submission at another account handoff via UPDATE', () => {
    const db = database();
    insertSubmission(db, 'submission-a', 'account-a', 'friend-a', 'handoff-a');

    expect(() => db.prepare(`UPDATE pharmacy_prescription_submissions
      SET source_handoff_id = 'handoff-b' WHERE id = 'submission-a'`).run())
      .toThrow(/PHARMACY_SUBMISSION_SOURCE_HANDOFF_SCOPE_MISMATCH/);
  });

  it('L-3: pharmacy_prescription_files/events already reject a submission_id that does not exist', () => {
    const db = database();
    insertSubmission(db, 'submission-a', 'account-a', 'friend-a', null);

    expect(() => db.prepare(`INSERT INTO pharmacy_prescription_files
      (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256, state, created_at, updated_at)
      VALUES ('file-a', 'no-such-submission', 1, 1, 'custom/pharmacy/prescriptions/x/1/a',
              'image/png', 24, ?, 'ready', '2026-08-19', '2026-08-19')`)
      .run('a'.repeat(64)))
      .toThrow(/FOREIGN KEY constraint failed/);

    expect(() => db.prepare(`INSERT INTO pharmacy_prescription_events
      (id, submission_id, actor_type, event_type, created_at)
      VALUES ('event-a', 'no-such-submission', 'system', 'status_changed', '2026-08-19')`).run())
      .toThrow(/FOREIGN KEY constraint failed/);

    expect(() => db.prepare(`INSERT INTO pharmacy_prescription_files
      (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256, state, created_at, updated_at)
      VALUES ('file-b', 'submission-a', 1, 1, 'custom/pharmacy/prescriptions/x/1/b',
              'image/png', 24, ?, 'ready', '2026-08-19', '2026-08-19')`)
      .run('b'.repeat(64)))
      .not.toThrow();
  });
});
