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
  db.prepare(`INSERT INTO pharmacy_prescription_submissions
    (id, line_account_id, friend_id, idempotency_key, status, upload_revision, created_at, updated_at)
    VALUES ('submission-a', 'account-a', 'friend-a', 'request-a', 'received', 1, '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z')`).run();
}

describe('custom_003_pharmacy_fulfillment_quotes.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    seed(db);
  });

  it('stores the bounded decision contract with immutable revisions', () => {
    db.prepare(`INSERT INTO pharmacy_fulfillment_quotes
      (id, submission_id, line_account_id, revision, decision,
       reason_codes_json, requirements_json, estimated_ready_at, valid_until, created_by, created_at)
      VALUES ('quote-a', 'submission-a', 'account-a', 1, 'conditional',
        '["original_required"]', '[{"code":"original_required","status":"pending"}]',
        '2026-08-17T10:00:00Z', '2026-08-17T09:00:00Z', 'staff-a', '2026-08-17T08:00:00Z')`).run();
    expect(db.prepare('SELECT decision, revision FROM pharmacy_fulfillment_quotes').get()).toEqual({
      decision: 'conditional', revision: 1,
    });
    expect(() => db.prepare(`INSERT INTO pharmacy_fulfillment_quotes
      (id, submission_id, line_account_id, revision, decision, reason_codes_json, requirements_json, created_by, created_at)
      VALUES ('quote-b', 'submission-a', 'account-a', 1, 'fulfillable', '[]', '[]', 'staff-b', '2026-08-17T08:01:00Z')`).run()).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects unbounded or unsupported connector values', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_fulfillment_quotes
      (id, submission_id, line_account_id, revision, decision, reason_codes_json, requirements_json, created_by, created_at)
      VALUES ('quote-a', 'submission-a', 'account-a', 1, 'unknown', '[]', '[]', 'staff-a', '2026-08-17T08:00:00Z')`).run()).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(`INSERT INTO pharmacy_fulfillment_quotes
      (id, submission_id, line_account_id, revision, decision, reason_codes_json, requirements_json, created_by, created_at)
      VALUES ('quote-b', 'submission-a', 'account-a', 1, 'fulfillable', 'not-json', '[]', 'staff-a', '2026-08-17T08:00:00Z')`).run()).toThrow(/CHECK constraint failed/);
  });
});
