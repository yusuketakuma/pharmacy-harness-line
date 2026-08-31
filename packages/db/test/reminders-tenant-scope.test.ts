import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelFriendReminder,
  createReminder,
  createReminderStep,
  deleteReminder,
  deleteReminderStep,
  enrollFriendInReminder,
  getDueReminderDeliveries,
  getFriendReminderById,
  getFriendReminders,
  getReminderById,
  getReminderSteps,
  getReminders,
  updateReminder,
} from '../src/reminders.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-30T12:00:00.000+09:00';

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  } as unknown as D1PreparedStatement);
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function insertAccount(
  sqlite: Database.Database,
  id: string,
  options: { tenantId?: string; mapped?: boolean; active?: boolean } = {},
): void {
  const now = '2026-08-30T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `channel-${id}`, id, `token-${id}`, `secret-${id}`, options.active === false ? 0 : 1, now, now);

  if (options.mapped !== false) {
    const tenantId = options.tenantId ?? `tenant-${id}`;
    sqlite.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(tenantId, tenantId, tenantId, now, now);
    sqlite.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)`)
      .run(tenantId, id, now, now);
  }
}

function insertFriend(sqlite: Database.Database, id: string, lineAccountId: string | null): void {
  const now = '2026-08-30T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO friends
    (id, line_user_id, provider_line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run(id, `line-${id}`, `provider-${id}`, lineAccountId, now, now);
}

function insertStaff(
  sqlite: Database.Database,
  staffId = 'staff-a',
  tenantId = 'tenant-a',
  active = true,
): void {
  const now = '2026-08-30T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, 'staff', ?, 1, ?, ?)`).run(
    staffId,
    staffId,
    `api-key-${staffId}`,
    now,
    now,
  );
  sqlite.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'staff', ?, ?, ?)`).run(
    tenantId,
    staffId,
    active ? 1 : 0,
    now,
    now,
  );
}

function insertReminder(sqlite: Database.Database, id: string, lineAccountId: string | null): void {
  const now = '2026-08-30T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO reminders
    (id, name, line_account_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`)
    .run(id, id, lineAccountId, now, now);
}

function insertStep(sqlite: Database.Database, reminderId: string, id = `${reminderId}-step`): void {
  sqlite.prepare(`INSERT INTO reminder_steps
    (id, reminder_id, offset_minutes, message_type, message_content, created_at)
    VALUES (?, ?, 0, 'text', ?, ?)`)
    .run(id, reminderId, `message-${reminderId}`, '2026-08-30T00:00:00.000+09:00');
}

function insertEnrollment(
  sqlite: Database.Database,
  id: string,
  friendId: string,
  reminderId: string,
): void {
  sqlite.prepare(`INSERT INTO friend_reminders
    (id, friend_id, reminder_id, target_date, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)`)
    .run(id, friendId, reminderId, '2026-08-30T11:00:00.000+09:00',
      '2026-08-30T00:00:00.000+09:00', '2026-08-30T00:00:00.000+09:00');
}

describe('generic reminder account boundaries', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    insertAccount(sqlite, 'account-a', { tenantId: 'tenant-a' });
    insertAccount(sqlite, 'account-b', { tenantId: 'tenant-b' });
    insertStaff(sqlite);
    db = d1From(sqlite);
  });

  it('does not insert a cross-account or unscoped enrollment', async () => {
    insertFriend(sqlite, 'friend-a', 'account-a');
    insertFriend(sqlite, 'friend-null', null);
    insertReminder(sqlite, 'reminder-a', 'account-a');
    insertReminder(sqlite, 'reminder-b', 'account-b');
    insertReminder(sqlite, 'reminder-null', null);

    await expect(enrollFriendInReminder(db, {
      friendId: 'friend-a', reminderId: 'reminder-b', targetDate: NOW, tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    await expect(enrollFriendInReminder(db, {
      friendId: 'friend-a', reminderId: 'reminder-null', targetDate: NOW, tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    await expect(enrollFriendInReminder(db, {
      friendId: 'friend-null', reminderId: 'reminder-a', targetDate: NOW, tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM friend_reminders').get())
      .toEqual({ count: 0 });
  });

  it('inserts a same-account enrollment only for the authenticated tenant', async () => {
    insertFriend(sqlite, 'friend-a', 'account-a');
    insertReminder(sqlite, 'reminder-a', 'account-a');

    const enrollment = await enrollFriendInReminder(db, {
      friendId: 'friend-a', reminderId: 'reminder-a', targetDate: NOW, tenantId: 'tenant-a', staffId: 'staff-a',
    });

    expect(enrollment).toMatchObject({
      friend_id: 'friend-a', reminder_id: 'reminder-a', target_date: NOW, status: 'active',
    });
  });

  it('does not insert when the server-resolved staff membership is inactive', async () => {
    sqlite.prepare(`UPDATE tenant_staff_memberships SET is_active = 0
      WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`).run();
    insertFriend(sqlite, 'friend-a', 'account-a');
    insertReminder(sqlite, 'reminder-a', 'account-a');

    await expect(enrollFriendInReminder(db, {
      friendId: 'friend-a', reminderId: 'reminder-a', targetDate: NOW,
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM friend_reminders').get())
      .toEqual({ count: 0 });
  });

  it('lists, reads, and lists steps only for active accounts mapped to the tenant', async () => {
    insertAccount(sqlite, 'account-inactive', { tenantId: 'tenant-inactive', active: false });
    insertReminder(sqlite, 'reminder-a', 'account-a');
    insertReminder(sqlite, 'reminder-b', 'account-b');
    insertReminder(sqlite, 'reminder-null', null);
    insertReminder(sqlite, 'reminder-inactive', 'account-inactive');
    insertStep(sqlite, 'reminder-a');
    insertStep(sqlite, 'reminder-b');

    expect((await getReminders(db, 'tenant-a')).map((row) => row.id))
      .toEqual(['reminder-a']);
    expect((await getReminders(db, 'tenant-a', 'account-b')).map((row) => row.id))
      .toEqual([]);
    expect(await getReminderById(db, 'reminder-a', 'tenant-a')).toMatchObject({
      id: 'reminder-a', line_account_id: 'account-a',
    });
    expect(await getReminderById(db, 'reminder-b', 'tenant-a')).toBeNull();
    expect(await getReminderById(db, 'reminder-null', 'tenant-a')).toBeNull();
    expect((await getReminderSteps(db, 'reminder-a', 'tenant-a')).map((row) => row.id))
      .toEqual(['reminder-a-step']);
    expect(await getReminderSteps(db, 'reminder-b', 'tenant-a')).toEqual([]);
  });

  it('creates a reminder with its account owner in one scoped insert', async () => {
    const created = await createReminder(db, {
      name: 'Owned reminder',
      description: 'Description',
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });

    expect(created).toMatchObject({
      name: 'Owned reminder', description: 'Description', line_account_id: 'account-a',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM reminders').get()).toEqual({ count: 1 });

    await expect(createReminder(db, {
      name: 'Foreign', lineAccountId: 'account-b', tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    await expect(createReminder(db, {
      name: 'Unscoped', lineAccountId: '', tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM reminders').get()).toEqual({ count: 1 });

    sqlite.prepare(`UPDATE tenant_staff_memberships SET is_active = 0
      WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`).run();
    await expect(createReminder(db, {
      name: 'Inactive staff', lineAccountId: 'account-a', tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM reminders').get()).toEqual({ count: 1 });
  });

  it('rechecks tenant staff scope for reminder and step mutations', async () => {
    insertReminder(sqlite, 'reminder-a', 'account-a');
    insertReminder(sqlite, 'reminder-b', 'account-b');

    const updated = await updateReminder(db, 'reminder-a', { name: 'Updated' }, {
      tenantId: 'tenant-a', staffId: 'staff-a',
    });
    expect(updated).toMatchObject({ id: 'reminder-a', name: 'Updated' });
    await expect(updateReminder(db, 'reminder-b', { name: 'Leaked' }, {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();

    const step = await createReminderStep(db, {
      reminderId: 'reminder-a', offsetMinutes: -60, messageType: 'text',
      messageContent: 'Soon', tenantId: 'tenant-a', staffId: 'staff-a',
    });
    expect(step).toMatchObject({ reminder_id: 'reminder-a', message_content: 'Soon' });
    await expect(createReminderStep(db, {
      reminderId: 'reminder-b', offsetMinutes: 0, messageType: 'text',
      messageContent: 'Foreign', tenantId: 'tenant-a', staffId: 'staff-a',
    })).resolves.toBeNull();
    expect(await deleteReminderStep(db, 'reminder-b', step!.id, {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBe(false);
    expect(await deleteReminderStep(db, 'reminder-a', step!.id, {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBe(true);

    sqlite.prepare(`UPDATE tenant_staff_memberships SET is_active = 0
      WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`).run();
    expect(await updateReminder(db, 'reminder-a', { name: 'Blocked' }, {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBeNull();
    expect(await deleteReminder(db, 'reminder-a', {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBe(false);
  });

  it('lists and cancels only same-account friend reminders for the tenant', async () => {
    insertFriend(sqlite, 'friend-a', 'account-a');
    insertFriend(sqlite, 'friend-b', 'account-b');
    insertFriend(sqlite, 'friend-null', null);
    insertReminder(sqlite, 'reminder-a', 'account-a');
    insertReminder(sqlite, 'reminder-b', 'account-b');
    insertReminder(sqlite, 'reminder-null', null);
    insertEnrollment(sqlite, 'enroll-good', 'friend-a', 'reminder-a');
    insertEnrollment(sqlite, 'enroll-cross-reminder', 'friend-a', 'reminder-b');
    insertEnrollment(sqlite, 'enroll-cross-friend', 'friend-b', 'reminder-a');
    insertEnrollment(sqlite, 'enroll-null', 'friend-null', 'reminder-null');

    expect((await getFriendReminders(db, 'friend-a', 'tenant-a')).map((row) => row.id))
      .toEqual(['enroll-good']);
    expect(await getFriendReminderById(db, 'enroll-cross-reminder', 'tenant-a')).toBeNull();
    expect(await getFriendReminderById(db, 'enroll-null', 'tenant-a')).toBeNull();
    expect(await getFriendReminderById(db, 'enroll-good', 'tenant-a')).toMatchObject({
      id: 'enroll-good', line_account_id: 'account-a',
    });

    expect(await cancelFriendReminder(db, 'enroll-cross-reminder', {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBe(false);
    expect(await cancelFriendReminder(db, 'enroll-good', {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBe(true);
    expect(sqlite.prepare(`SELECT status FROM friend_reminders WHERE id = 'enroll-good'`).get())
      .toEqual({ status: 'cancelled' });

    sqlite.prepare(`UPDATE tenant_staff_memberships SET is_active = 0
      WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`).run();
    expect(await cancelFriendReminder(db, 'enroll-good', {
      tenantId: 'tenant-a', staffId: 'staff-a',
    })).toBe(false);
  });

  it('returns only due rows whose reminder and friend share an active mapped account', async () => {
    insertAccount(sqlite, 'account-inactive', { tenantId: 'tenant-inactive', active: false });
    insertAccount(sqlite, 'account-unmapped', { mapped: false });

    insertFriend(sqlite, 'friend-a', 'account-a');
    insertFriend(sqlite, 'friend-b', 'account-b');
    insertFriend(sqlite, 'friend-null', null);
    insertFriend(sqlite, 'friend-inactive', 'account-inactive');
    insertFriend(sqlite, 'friend-unmapped', 'account-unmapped');

    insertReminder(sqlite, 'reminder-a', 'account-a');
    insertReminder(sqlite, 'reminder-null', null);
    insertReminder(sqlite, 'reminder-inactive', 'account-inactive');
    insertReminder(sqlite, 'reminder-unmapped', 'account-unmapped');
    insertStep(sqlite, 'reminder-a');
    insertStep(sqlite, 'reminder-null');
    insertStep(sqlite, 'reminder-inactive');
    insertStep(sqlite, 'reminder-unmapped');

    insertEnrollment(sqlite, 'enroll-good', 'friend-a', 'reminder-a');
    insertEnrollment(sqlite, 'enroll-cross-account', 'friend-b', 'reminder-a');
    insertEnrollment(sqlite, 'enroll-null-reminder', 'friend-a', 'reminder-null');
    insertEnrollment(sqlite, 'enroll-null-friend', 'friend-null', 'reminder-a');
    insertEnrollment(sqlite, 'enroll-inactive', 'friend-inactive', 'reminder-inactive');
    insertEnrollment(sqlite, 'enroll-unmapped', 'friend-unmapped', 'reminder-unmapped');

    const due = await getDueReminderDeliveries(db, NOW);

    expect(due.map((row) => row.id)).toEqual(['enroll-good']);
    expect(due[0]?.steps.map((step) => step.id)).toEqual(['reminder-a-step']);
  });
});
