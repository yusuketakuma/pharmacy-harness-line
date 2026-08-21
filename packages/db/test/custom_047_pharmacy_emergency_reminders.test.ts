import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_047_pharmacy_emergency_reminders.sql');
const HASH = 'a'.repeat(64);

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE pharmacy_staff_accounts (
      line_account_id TEXT NOT NULL, staff_id TEXT NOT NULL,
      PRIMARY KEY (line_account_id, staff_id)
    );
    CREATE TABLE pharmacy_emergency_intakes (
      id TEXT NOT NULL, line_account_id TEXT NOT NULL,
      PRIMARY KEY (id, line_account_id)
    );
    INSERT INTO line_accounts VALUES ('account-a'), ('account-b');
    INSERT INTO pharmacy_staff_accounts VALUES ('account-a', 'staff-a'), ('account-b', 'staff-b');
    INSERT INTO pharmacy_emergency_intakes VALUES ('intake-a', 'account-a'), ('intake-b', 'account-b');
  `);
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

describe('custom_047 pharmacy emergency reminders', () => {
  it('keeps account reminder activation dormant until explicitly enabled or frozen', () => {
    const db = setup();
    expect(db.prepare(`SELECT state FROM pharmacy_emergency_reminder_controls
      WHERE line_account_id = 'account-a'`).get()).toBeUndefined();
    db.prepare(`INSERT INTO pharmacy_emergency_reminder_controls
      (line_account_id, state, time_zone, revision, updated_by, created_at, updated_at)
      VALUES ('account-a', 'active', 'Asia/Tokyo', 1, 'staff-a',
              '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`).run();
    db.prepare(`UPDATE pharmacy_emergency_reminder_controls
      SET state = 'frozen', revision = 2, updated_at = '2026-08-21T00:01:00Z'
      WHERE line_account_id = 'account-a' AND revision = 1`).run();
    expect(db.prepare(`SELECT state, time_zone, revision
      FROM pharmacy_emergency_reminder_controls WHERE line_account_id = 'account-a'`).get())
      .toEqual({ state: 'frozen', time_zone: 'Asia/Tokyo', revision: 2 });
    expect(() => db.prepare(`UPDATE pharmacy_emergency_reminder_controls
      SET time_zone = 'Invalid/Zone' WHERE line_account_id = 'account-a'`).run()).toThrow(/check/i);
  });

  it('stores one PHI-free occurrence for one intake anchor and rejects cross-account rows', () => {
    const db = setup();
    const insert = (id: string, intakeId = 'intake-a', accountId = 'account-a', hash = HASH) =>
      db.prepare(`INSERT INTO pharmacy_emergency_reminders
        (id, line_account_id, intake_id, reminder_kind, anchor_at, due_at, deadline_at,
         occurrence_hash, status, attempt_count, created_at, updated_at)
        VALUES (?, ?, ?, 'appointment_neutral_v1', '2026-08-21T01:00:00Z',
                '2026-08-21T00:00:00Z', '2026-08-21T01:00:00Z', ?, 'pending', 0,
                '2026-08-20T23:00:00Z', '2026-08-20T23:00:00Z')`)
        .run(id, accountId, intakeId, hash);

    expect(insert('reminder-a').changes).toBe(1);
    expect(() => insert('duplicate')).toThrow(/unique/i);
    expect(() => insert('cross-account', 'intake-b', 'account-a', 'b'.repeat(64)))
      .toThrow(/foreign key/i);
    expect(() => db.prepare(`UPDATE pharmacy_emergency_reminders
      SET anchor_at = '2026-08-22T01:00:00Z' WHERE id = 'reminder-a'`).run()).toThrow(/immutable/i);
  });

  it('requires claim evidence and keeps terminal delivery rows immutable without PHI columns', () => {
    const db = setup();
    db.prepare(`INSERT INTO pharmacy_emergency_reminders
      (id, line_account_id, intake_id, reminder_kind, anchor_at, due_at, deadline_at,
       occurrence_hash, status, attempt_count, created_at, updated_at)
      VALUES ('reminder-a', 'account-a', 'intake-a', 'appointment_neutral_v1',
              '2026-08-21T01:00:00Z', '2026-08-21T00:00:00Z', '2026-08-21T01:00:00Z',
              ?, 'pending', 0, '2026-08-20T23:00:00Z', '2026-08-20T23:00:00Z')`).run(HASH);
    expect(() => db.prepare(`UPDATE pharmacy_emergency_reminders
      SET status = 'processing' WHERE id = 'reminder-a'`).run()).toThrow(/check/i);
    db.prepare(`UPDATE pharmacy_emergency_reminders
      SET status = 'sent', sent_at = '2026-08-21T00:00:01Z', updated_at = '2026-08-21T00:00:01Z'
      WHERE id = 'reminder-a'`).run();
    expect(() => db.prepare(`UPDATE pharmacy_emergency_reminders
      SET status = 'failed' WHERE id = 'reminder-a'`).run()).toThrow(/immutable/i);

    const columns = (db.prepare(`PRAGMA table_info(pharmacy_emergency_reminders)`).all() as Array<{ name: string }>)
      .map(({ name }) => name);
    expect(columns).not.toEqual(expect.arrayContaining([
      'friend_id', 'line_user_id', 'reference_code', 'patient_name', 'payload', 'drug_name',
    ]));
  });
});
