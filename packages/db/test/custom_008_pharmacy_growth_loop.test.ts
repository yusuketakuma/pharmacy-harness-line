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

describe('custom_008_pharmacy_growth_loop.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, ?, ?)`)
      .run('account-a', 'channel-a', 'A', 'token-a', 'secret-a');
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
      (id, line_account_id, message_id, category, outcome, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('notice-a', 'account-a', 'unknown', 'transactional_care', 'sent', '2026-08-17T00:00:00.000Z', 'notice-a', '2026-08-17T00:00:00.000Z'))
      .not.toThrow();
    expect(() => db.prepare(`INSERT INTO pharmacy_notification_events
      (id, line_account_id, message_id, category, outcome, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('notice-b', 'account-a', 'unknown', 'transactional_care', 'sent', '2026-08-17T00:00:00.000Z', 'notice-a', '2026-08-17T00:00:00.000Z'))
      .toThrow(/UNIQUE constraint failed/i);
  });
});
