import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = 'a'.repeat(64);

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DROP TRIGGER pharmacy_emergency_intake_active_assignment;
    DROP TRIGGER pharmacy_emergency_intake_readiness;
    DROP TRIGGER pharmacy_emergency_intake_slot_capacity;
    DROP TRIGGER pharmacy_emergency_intake_stock;
  `);
  db.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES
      ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
      ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
    INSERT INTO tenants (id, tenant_code, display_name) VALUES
      ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES
      ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
    INSERT INTO staff_members (id, name, role, api_key) VALUES
      ('staff-a', 'A', 'staff', 'key-a'), ('staff-b', 'B', 'staff', 'key-b');
    INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role) VALUES
      ('tenant-a', 'staff-a', 'staff'), ('tenant-b', 'staff-b', 'staff');
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, created_at, updated_at) VALUES
      ('account-a', 'staff-a', '2026-08-21', '2026-08-21'),
      ('account-b', 'staff-b', '2026-08-21', '2026-08-21');
    INSERT INTO pharmacy_emergency_intakes
      (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
       encrypted_payload, age_band, safe_contact_mode, consent_version,
       idempotency_key, expires_at, created_at, updated_at) VALUES
      ('intake-a', 'REFERENCE-A1', 'tenant-a', 'account-a', 'friend-a', 'slot-a',
       'ciphertext', 'adult', 'neutral_line', 'v1', 'intake-key-a',
       '2026-08-22', '2026-08-21', '2026-08-21'),
      ('intake-b', 'REFERENCE-B1', 'tenant-b', 'account-b', 'friend-b', 'slot-b',
       'ciphertext', 'adult', 'neutral_line', 'v1', 'intake-key-b',
       '2026-08-22', '2026-08-21', '2026-08-21');
  `);
  db.pragma('foreign_keys = ON');
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
