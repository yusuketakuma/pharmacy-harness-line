import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const dbMocks = vi.hoisted(() => ({
  getReminders: vi.fn(),
  getReminderById: vi.fn(),
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  getReminderSteps: vi.fn(),
  createReminderStep: vi.fn(),
  deleteReminderStep: vi.fn(),
  enrollFriendInReminder: vi.fn(),
  getFriendReminders: vi.fn(),
  getFriendReminderById: vi.fn(),
  cancelFriendReminder: vi.fn(),
  getFriendById: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

const boundaryMocks = vi.hoisted(() => ({
  accountResourceOwnedByStaff: vi.fn(),
}));
vi.mock('../../middleware/tenant-boundary.js', () => boundaryMocks);

const { reminders } = await import('./reminders.js');

function reminder(lineAccountId: string | null, id = 'reminder-a') {
  return {
    id,
    name: 'Reminder A',
    description: null,
    is_active: 1,
    created_at: '2026-08-30T00:00:00.000+09:00',
    updated_at: '2026-08-30T00:00:00.000+09:00',
    line_account_id: lineAccountId,
  };
}

function friend(lineAccountId: string | null, id = 'friend-a') {
  return { id, line_account_id: lineAccountId };
}

function setup(options: { tenantId?: string; staffId?: string } = {}) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (options.tenantId !== undefined) c.set('tenantId', options.tenantId);
    if (options.staffId !== undefined) c.set('staff', {
      id: options.staffId,
      name: 'Staff',
      role: 'staff',
    });
    await next();
  });
  app.route('/', reminders);
  return { app, env: { DB: {} as D1Database } as Env['Bindings'] };
}

async function request(
  app: Hono<Env>,
  env: Env['Bindings'],
  path: string,
  init?: RequestInit,
) {
  return app.request(path, init, env);
}

async function postEnrollment(app: Hono<Env>, env: Env['Bindings']) {
  return request(app, env, '/api/reminders/reminder-a/enroll/friend-a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetDate: '2026-09-01T09:00:00+09:00' }),
  });
}

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
  boundaryMocks.accountResourceOwnedByStaff.mockReset();
});

describe('reminder CRUD account boundary', () => {
  it('requires the authenticated tenant and staff context for listing', async () => {
    const { app, env } = setup();

    const response = await request(app, env, '/api/reminders');

    expect(response.status).toBe(401);
    expect(dbMocks.getReminders).not.toHaveBeenCalled();
  });

  it('uses only the server tenant and an authorized account selector for listing', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.getReminders.mockResolvedValue([]);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await request(app, env, '/api/reminders?lineAccountId=account-a');

    expect(response.status).toBe(200);
    expect(boundaryMocks.accountResourceOwnedByStaff)
      .toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'account-a');
    expect(dbMocks.getReminders).toHaveBeenCalledWith(env.DB, 'tenant-a', 'account-a');
  });

  it('rejects a foreign account selector before reading reminders', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await request(app, env, '/api/reminders?lineAccountId=account-b');

    expect(response.status).toBe(403);
    expect(dbMocks.getReminders).not.toHaveBeenCalled();
  });

  it('does not return a reminder from a foreign account or unscoped legacy row', async () => {
    for (const row of [reminder('account-b'), reminder(null)]) {
      dbMocks.getReminderById.mockResolvedValue(row);
      const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

      const response = await request(app, env, '/api/reminders/reminder-a');

      expect(response.status).toBe(404);
      expect(dbMocks.getReminderSteps).not.toHaveBeenCalled();
      dbMocks.getReminderById.mockReset();
    }
  });

  it('scopes detail and step list through the owned reminder account', async () => {
    dbMocks.getReminderById.mockResolvedValue(reminder('account-a'));
    dbMocks.getReminderSteps.mockResolvedValue([]);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const detail = await request(app, env, '/api/reminders/reminder-a');
    const steps = await request(app, env, '/api/reminders/reminder-a/steps');

    expect(detail.status).toBe(200);
    expect(steps.status).toBe(200);
    expect(dbMocks.getReminderById).toHaveBeenCalledWith(env.DB, 'reminder-a', 'tenant-a');
    expect(dbMocks.getReminderSteps).toHaveBeenCalledWith(env.DB, 'reminder-a', 'tenant-a');
  });

  it('requires an authorized selected account and atomically passes the server scope on create', async () => {
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const missingAccount = await request(app, env, '/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No owner' }),
    });
    expect(missingAccount.status).toBe(400);
    expect(dbMocks.createReminder).not.toHaveBeenCalled();

    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const foreignAccount = await request(app, env, '/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Foreign', lineAccountId: 'account-b' }),
    });
    expect(foreignAccount.status).toBe(403);
    expect(dbMocks.createReminder).not.toHaveBeenCalled();

    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.createReminder.mockResolvedValue(reminder('account-a'));
    const valid = await request(app, env, '/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Owned',
        description: 'Description',
        lineAccountId: 'account-a',
        tenantId: 'tenant-b',
      }),
    });

    expect(valid.status).toBe(201);
    expect(dbMocks.createReminder).toHaveBeenCalledWith(env.DB, {
      name: 'Owned',
      description: 'Description',
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });
  });

  it('authorizes update and ignores a body account spoof', async () => {
    dbMocks.getReminderById.mockResolvedValue(reminder('account-a'));
    dbMocks.updateReminder.mockResolvedValue({ ...reminder('account-a'), name: 'Updated' });
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await request(app, env, '/api/reminders/reminder-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated', lineAccountId: 'account-b', tenantId: 'tenant-b' }),
    });

    expect(response.status).toBe(200);
    expect(dbMocks.updateReminder).toHaveBeenCalledWith(
      env.DB,
      'reminder-a',
      { name: 'Updated' },
      { tenantId: 'tenant-a', staffId: 'staff-a' },
    );
  });

  it('rejects foreign delete and scopes an owned delete', async () => {
    dbMocks.getReminderById.mockResolvedValue(reminder('account-b'));
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const foreign = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });
    const foreignResponse = await request(foreign.app, foreign.env, '/api/reminders/reminder-a', { method: 'DELETE' });
    expect(foreignResponse.status).toBe(404);
    expect(dbMocks.deleteReminder).not.toHaveBeenCalled();

    dbMocks.getReminderById.mockResolvedValue(reminder('account-a'));
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.deleteReminder.mockResolvedValue(true);
    const owned = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });
    const ownedResponse = await request(owned.app, owned.env, '/api/reminders/reminder-a', { method: 'DELETE' });
    expect(ownedResponse.status).toBe(200);
    expect(dbMocks.deleteReminder).toHaveBeenCalledWith(owned.env.DB, 'reminder-a', {
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });
  });

  it('scopes step create and delete to the parent reminder', async () => {
    dbMocks.getReminderById.mockResolvedValue(reminder('account-a'));
    dbMocks.createReminderStep.mockResolvedValue({
      id: 'step-a',
      reminder_id: 'reminder-a',
      offset_minutes: -60,
      message_type: 'text',
      message_content: 'Soon',
      created_at: '2026-08-30T00:00:00.000+09:00',
    });
    dbMocks.deleteReminderStep.mockResolvedValue(true);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const created = await request(app, env, '/api/reminders/reminder-a/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offsetMinutes: -60, messageType: 'text', messageContent: 'Soon' }),
    });
    const deleted = await request(app, env, '/api/reminders/reminder-a/steps/step-a', { method: 'DELETE' });

    expect(created.status).toBe(201);
    expect(deleted.status).toBe(200);
    expect(dbMocks.createReminderStep).toHaveBeenCalledWith(env.DB, {
      reminderId: 'reminder-a',
      offsetMinutes: -60,
      messageType: 'text',
      messageContent: 'Soon',
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });
    expect(dbMocks.deleteReminderStep).toHaveBeenCalledWith(env.DB, 'reminder-a', 'step-a', {
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });
  });
});

describe('friend reminder account boundary', () => {
  it('requires the authenticated tenant and staff context for enrollment', async () => {
    const { app, env } = setup({ tenantId: 'tenant-a' });

    const response = await postEnrollment(app, env);

    expect(response.status).toBe(401);
    expect(dbMocks.getReminderById).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInReminder).not.toHaveBeenCalled();
  });

  it.each([
    ['different accounts', reminder('account-b'), friend('account-a')],
    ['an unscoped reminder', reminder(null), friend('account-a')],
    ['an unscoped friend', reminder('account-a'), friend(null)],
  ])('rejects enrollment for %s without creating a relation', async (_label, reminderRow, friendRow) => {
    dbMocks.getReminderById.mockResolvedValue(reminderRow);
    dbMocks.getFriendById.mockResolvedValue(friendRow);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await postEnrollment(app, env);

    expect(response.status).toBe(404);
    expect(dbMocks.enrollFriendInReminder).not.toHaveBeenCalled();
  });

  it('rechecks the owned account before enrollment and passes server staff scope', async () => {
    dbMocks.getReminderById.mockResolvedValue(reminder('account-a'));
    dbMocks.getFriendById.mockResolvedValue(friend('account-a'));
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.enrollFriendInReminder.mockResolvedValue({
      id: 'friend-reminder-a',
      friend_id: 'friend-a',
      reminder_id: 'reminder-a',
      target_date: '2026-09-01T09:00:00+09:00',
      status: 'active',
      created_at: '2026-08-30T00:00:00.000+09:00',
      updated_at: '2026-08-30T00:00:00.000+09:00',
    });
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await postEnrollment(app, env);

    expect(response.status).toBe(201);
    expect(dbMocks.enrollFriendInReminder).toHaveBeenCalledWith(env.DB, {
      friendId: 'friend-a',
      reminderId: 'reminder-a',
      targetDate: '2026-09-01T09:00:00+09:00',
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });
  });

  it('rejects a foreign friend list before reading relations', async () => {
    dbMocks.getFriendById.mockResolvedValue(friend('account-b'));
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await request(app, env, '/api/friends/friend-a/reminders');

    expect(response.status).toBe(404);
    expect(dbMocks.getFriendReminders).not.toHaveBeenCalled();
  });

  it('lists only the server-scoped friend relations', async () => {
    dbMocks.getFriendById.mockResolvedValue(friend('account-a'));
    dbMocks.getFriendReminders.mockResolvedValue([]);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const { app, env } = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await request(app, env, '/api/friends/friend-a/reminders');

    expect(response.status).toBe(200);
    expect(dbMocks.getFriendReminders).toHaveBeenCalledWith(env.DB, 'friend-a', 'tenant-a');
  });

  it('rejects and scopes friend-reminder cancellation by the mapped account', async () => {
    dbMocks.getFriendReminderById.mockResolvedValue({ ...friend('account-b'), id: 'friend-reminder-a' });
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const foreign = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });
    const foreignResponse = await request(foreign.app, foreign.env, '/api/friend-reminders/friend-reminder-a', { method: 'DELETE' });
    expect(foreignResponse.status).toBe(404);
    expect(dbMocks.cancelFriendReminder).not.toHaveBeenCalled();

    dbMocks.getFriendReminderById.mockResolvedValue({ ...friend('account-a'), id: 'friend-reminder-a' });
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.cancelFriendReminder.mockResolvedValue(true);
    const owned = setup({ tenantId: 'tenant-a', staffId: 'staff-a' });
    const ownedResponse = await request(owned.app, owned.env, '/api/friend-reminders/friend-reminder-a', { method: 'DELETE' });
    expect(ownedResponse.status).toBe(200);
    expect(dbMocks.cancelFriendReminder).toHaveBeenCalledWith(owned.env.DB, 'friend-reminder-a', {
      tenantId: 'tenant-a',
      staffId: 'staff-a',
    });
  });
});
