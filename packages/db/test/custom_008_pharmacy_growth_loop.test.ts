import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(join(ROOT, 'migrations/custom_008_pharmacy_growth_loop.sql'), 'utf8');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

describe('custom_008_pharmacy_growth_loop.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, ?, ?)`)
      .run('account-a', 'channel-a', 'A', 'token-a', 'secret-a');
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, ?, ?)`)
      .run('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
    db.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`)
      .run('friend-a', 'U-a', 'account-a', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');
    db.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, upload_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'received', 1, ?, ?)`)
      .run('submission-a', 'account-a', 'friend-a', 'request-a', '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z');
  });

  it('creates account-scoped capability, source, validity, and event tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name LIKE 'pharmacy_%' ORDER BY name`).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'pharmacy_account_capabilities',
      'pharmacy_staff_accounts',
      'pharmacy_growth_events',
      'pharmacy_medical_sources',
      'pharmacy_submission_sources',
      'pharmacy_prescription_validities',
      'pharmacy_notification_events',
      'pharmacy_submission_attributes',
    ]));
  });

  it('keeps growth idempotency and notification category constraints', () => {
    db.prepare(`INSERT INTO pharmacy_growth_events
      (id, line_account_id, event_type, aggregate_id, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('event-a', 'account-a', 'first_follow', 'friend-a', '2026-08-17T00:00:00.000Z', 'follow:friend-a', '2026-08-17T00:00:00.000Z');
    expect(() => db.prepare(`INSERT INTO pharmacy_growth_events
      (id, line_account_id, event_type, aggregate_id, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('event-b', 'account-a', 'first_follow', 'friend-a', '2026-08-17T00:00:01.000Z', 'follow:friend-a', '2026-08-17T00:00:01.000Z'))
      .toThrow(/UNIQUE constraint failed/i);

    expect(() => db.prepare(`INSERT INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('notice-a', 'account-a', 'friend-a', 'unknown', 'transactional_care', 'sent', '2026-08-17T00:00:00.000Z', 'notice-a', '2026-08-17T00:00:00.000Z'))
      .not.toThrow();
    expect(() => db.prepare(`INSERT INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('notice-b', 'account-a', 'friend-a', 'unknown', 'transactional_care', 'sent', '2026-08-17T00:00:00.000Z', 'notice-a', '2026-08-17T00:00:00.000Z'))
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('enforces account boundaries with composite foreign keys', () => {
    db.prepare(`INSERT INTO pharmacy_medical_sources
      (id, line_account_id, display_name, classification, created_by, created_at, updated_at)
      VALUES ('source-b', 'account-b', 'Clinic B', 'other', 'staff-a', '2026-08-17', '2026-08-17')`).run();

    expect(() => db.prepare(`INSERT INTO pharmacy_submission_sources
      (submission_id, line_account_id, source_id, classification, entered_by, entered_at, updated_at)
      VALUES ('submission-a', 'account-b', NULL, 'unknown', 'staff-a', '2026-08-17', '2026-08-17')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`INSERT INTO pharmacy_submission_sources
      (submission_id, line_account_id, source_id, classification, entered_by, entered_at, updated_at)
      VALUES ('submission-a', 'account-a', 'source-b', 'other', 'staff-a', '2026-08-17', '2026-08-17')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, validity_basis, verification_status, created_at, updated_at)
      VALUES ('submission-a', 'account-b', 'default_4_days', 'unverified', '2026-08-17', '2026-08-17')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`INSERT INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome, occurred_at, idempotency_key, created_at)
      VALUES ('notice-cross', 'account-b', 'friend-a', 'pharmacy_onboarding_v1', 'transactional_care', 'sent', '2026-08-17', 'notice-cross', '2026-08-17')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('reapplies cleanly and resumes after a partially applied migration', () => {
    expect(() => db.exec(MIGRATION)).not.toThrow();

    const partial = new Database(':memory:');
    partial.pragma('foreign_keys = ON');
    partial.exec(`
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
      CREATE TABLE staff_members (id TEXT PRIMARY KEY);
      CREATE TABLE friends (id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL);
      CREATE UNIQUE INDEX idx_friends_id_line_account ON friends(id, line_account_id);
      CREATE TABLE pharmacy_prescription_submissions (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL
      );
    `);
    const statements = MIGRATION.split(';').map((statement) => statement.trim()).filter(Boolean);
    partial.exec(`${statements.slice(0, 5).join(';')};`);
    expect(() => partial.exec(MIGRATION)).not.toThrow();
    expect(partial.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'pharmacy_notification_events'`).get())
      .toEqual({ count: 1 });
  });

  it('requires dates and verifier identity for verified validity', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, validity_basis, verification_status, created_at, updated_at)
      VALUES ('submission-a', 'account-a', 'default_4_days', 'verified', '2026-08-17', '2026-08-17')`).run())
      .toThrow(/CHECK constraint failed/i);
  });

  it('appends PHI-free audit events for manual classification and validity changes', () => {
    db.prepare(`INSERT INTO pharmacy_submission_sources
      (submission_id, line_account_id, source_id, classification, entered_by, entered_at, updated_at)
      VALUES ('submission-a', 'account-a', NULL, 'unknown', 'staff-a', '2026-08-17', '2026-08-17')`).run();
    db.prepare(`INSERT INTO pharmacy_prescription_validities
      (submission_id, line_account_id, issued_on, valid_until, validity_basis,
       verification_status, verified_by, verified_at, created_at, updated_at)
      VALUES ('submission-a', 'account-a', '2026-08-17', '2026-08-20', 'default_4_days',
              'verified', 'staff-a', '2026-08-17', '2026-08-17', '2026-08-17')`).run();

    const events = db.prepare(`SELECT event_type, metadata_json FROM pharmacy_growth_events
      WHERE line_account_id = 'account-a' ORDER BY event_type`).all() as Array<{
        event_type: string; metadata_json: string;
      }>;
    expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'submission_source_classified', 'prescription_validity_updated',
    ]));
    expect(events.every((event) => event.metadata_json === '{}')).toBe(true);
  });
});
