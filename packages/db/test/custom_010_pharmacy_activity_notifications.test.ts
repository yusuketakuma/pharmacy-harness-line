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
  db.exec(readFileSync(
    join(ROOT, 'migrations/custom_010_pharmacy_activity_notifications.sql'),
    'utf8',
  ));
  return db;
}

function seedAccount(db: Database.Database, accountId: string): void {
  db.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
     VALUES (?, ?, ?, 'token', 'secret', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(accountId, `channel-${accountId}`, `Pharmacy ${accountId}`);
  db.prepare(
    `INSERT INTO staff
       (id, line_account_id, name, display_name, created_at, updated_at)
     VALUES (?, ?, 'Staff', 'Staff', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(`staff-${accountId}`, accountId);
}

function seedStaff(db: Database.Database, staffId: string, accountId: string): void {
  db.prepare(
    `INSERT INTO staff
       (id, line_account_id, name, display_name, created_at, updated_at)
     VALUES (?, ?, 'Staff', 'Staff', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(staffId, accountId);
}

function insertNotification(
  db: Database.Database,
  values: {
    id: string;
    accountId: string;
    staffId: string;
    key: string;
    status?: string;
  },
): void {
  db.prepare(
    `INSERT INTO pharmacy_activity_notifications
       (id, line_account_id, staff_id, activity_type, idempotency_key,
        status, created_at, updated_at)
     VALUES (?, ?, ?, 'prescription_received', ?, ?,
             '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
  ).run(
    values.id,
    values.accountId,
    values.staffId,
    values.key,
    values.status ?? 'unread',
  );
}

describe('custom_010_pharmacy_activity_notifications.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    seedAccount(db, 'account-a');
    seedAccount(db, 'account-b');
    seedStaff(db, 'staff-account-a-2', 'account-a');
  });

  it('creates an account-scoped inbox and append-only audit table without payload copies', () => {
    const names = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN
         ('pharmacy_activity_notifications', 'pharmacy_activity_notification_events')
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    expect(names.map((row) => row.name)).toEqual([
      'pharmacy_activity_notification_events',
      'pharmacy_activity_notifications',
    ]);

    const columns = db.prepare(
      `SELECT name FROM pragma_table_info('pharmacy_activity_notifications') ORDER BY cid`,
    ).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['payload_json', 'patient_name', 'prescription_content', 'line_user_id']),
    );
  });

  it('scopes idempotency by account and recipient staff', () => {
    insertNotification(db, { id: 'notification-a', accountId: 'account-a', staffId: 'staff-account-a', key: 'event-1' });
    expect(() => insertNotification(db, {
      id: 'notification-a2', accountId: 'account-a', staffId: 'staff-account-a', key: 'event-1',
    })).toThrow(/UNIQUE constraint failed/);
    expect(() => insertNotification(db, {
      id: 'notification-a3', accountId: 'account-a', staffId: 'staff-account-a-2', key: 'event-1',
    })).not.toThrow();
    expect(() => insertNotification(db, {
      id: 'notification-b', accountId: 'account-b', staffId: 'staff-account-b', key: 'event-1',
    })).not.toThrow();
  });

  it('rejects unsupported status and activity types at the database boundary', () => {
    expect(() => insertNotification(db, {
      id: 'bad-status', accountId: 'account-a', staffId: 'staff-account-a', key: 'event-1', status: 'read',
    })).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(
      `INSERT INTO pharmacy_activity_notifications
         (id, line_account_id, staff_id, activity_type, idempotency_key,
          status, created_at, updated_at)
       VALUES ('bad-type', 'account-a', 'staff-account-a', '患者名を含む自由記述', 'event-2',
               'unread', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z')`,
    ).run()).toThrow(/CHECK constraint failed/);
  });

  it('requires audit rows to use the same tenant as their notification', () => {
    insertNotification(db, { id: 'notification-a', accountId: 'account-a', staffId: 'staff-account-a', key: 'event-1' });
    expect(() => db.prepare(
      `INSERT INTO pharmacy_activity_notification_events
         (id, notification_id, line_account_id, event_type, actor_type, created_at)
       VALUES ('audit-cross-tenant', 'notification-a', 'account-b', 'created', 'system',
               '2026-08-18T00:00:00Z')`,
    ).run()).toThrow(/FOREIGN KEY constraint failed/);
  });
});
