import { Hono, type Context } from 'hono';
import {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  getReminderSteps,
  createReminderStep,
  deleteReminderStep,
  enrollFriendInReminder,
  getFriendReminders,
  getFriendReminderById,
  cancelFriendReminder,
  getFriendById,
} from '@line-crm/db';
import type { Env } from '../../index.js';
import { accountResourceOwnedByStaff } from '../../middleware/tenant-boundary.js';

const reminders = new Hono<Env>();

type ReminderScope = { tenantId: string; staffId: string };

function resolveReminderScope(c: Context<Env>): ReminderScope | null {
  const tenantId = c.get('tenantId');
  const staffId = c.get('staff')?.id;
  if (!tenantId || !staffId) return null;
  return { tenantId, staffId };
}

async function getOwnedReminder(
  c: Context<Env>,
  reminderId: string,
  tenantId: string,
) {
  const reminder = await getReminderById(c.env.DB, reminderId, tenantId);
  if (!reminder?.line_account_id) return null;
  if (!await accountResourceOwnedByStaff(c, tenantId, reminder.line_account_id)) return null;
  return reminder;
}

function serializeReminder(row: Awaited<ReturnType<typeof getReminders>>[number]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeStep(row: Awaited<ReturnType<typeof getReminderSteps>>[number]) {
  return {
    id: row.id,
    reminderId: row.reminder_id,
    offsetMinutes: row.offset_minutes,
    messageType: row.message_type,
    messageContent: row.message_content,
    createdAt: row.created_at,
  };
}

// ========== リマインダCRUD =============

reminders.get('/api/reminders', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const lineAccountId = c.req.query('lineAccountId') || undefined;
    if (lineAccountId && !await accountResourceOwnedByStaff(c, scope.tenantId, lineAccountId)) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }
    const items = await getReminders(c.env.DB, scope.tenantId, lineAccountId);
    return c.json({ success: true, data: items.map(serializeReminder) });
  } catch (err) {
    console.error('GET /api/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/reminders/:id', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const id = c.req.param('id');
    const reminder = await getOwnedReminder(c, id, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    const steps = await getReminderSteps(c.env.DB, id, scope.tenantId);
    return c.json({
      success: true,
      data: { ...serializeReminder(reminder), steps: steps.map(serializeStep) },
    });
  } catch (err) {
    console.error('GET /api/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/reminders/:id/steps', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const id = c.req.param('id');
    const reminder = await getOwnedReminder(c, id, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    const steps = await getReminderSteps(c.env.DB, id, scope.tenantId);
    return c.json({ success: true, data: steps.map(serializeStep) });
  } catch (err) {
    console.error('GET /api/reminders/:id/steps error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.post('/api/reminders', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const body = await c.req.json<{
      name?: unknown;
      description?: unknown;
      lineAccountId?: unknown;
    }>();
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }
    if (
      body.description !== undefined
      && body.description !== null
      && typeof body.description !== 'string'
    ) {
      return c.json({ success: false, error: 'description must be a string' }, 400);
    }
    if (typeof body.lineAccountId !== 'string' || !body.lineAccountId.trim()) {
      return c.json({ success: false, error: 'lineAccountId is required' }, 400);
    }
    if (!await accountResourceOwnedByStaff(c, scope.tenantId, body.lineAccountId)) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const item = await createReminder(c.env.DB, {
      name: body.name,
      description: body.description as string | null | undefined,
      lineAccountId: body.lineAccountId,
      tenantId: scope.tenantId,
      staffId: scope.staffId,
    });
    if (!item) return c.json({ success: false, error: 'Reminder not found' }, 404);
    return c.json({
      success: true,
      data: { id: item.id, name: item.name, createdAt: item.created_at },
    }, 201);
  } catch (err) {
    console.error('POST /api/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.put('/api/reminders/:id', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const id = c.req.param('id');
    const reminder = await getOwnedReminder(c, id, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<Record<string, unknown>>();
    const updates: { name?: string; description?: string | null; isActive?: boolean } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return c.json({ success: false, error: 'name must be a non-empty string' }, 400);
      }
      updates.name = body.name;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return c.json({ success: false, error: 'description must be a string' }, 400);
      }
      updates.description = body.description as string | null;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') {
        return c.json({ success: false, error: 'isActive must be a boolean' }, 400);
      }
      updates.isActive = body.isActive;
    }

    const updated = await updateReminder(c.env.DB, id, updates, scope);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: updated.id, name: updated.name, isActive: Boolean(updated.is_active) },
    });
  } catch (err) {
    console.error('PUT /api/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/reminders/:id', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const id = c.req.param('id');
    const reminder = await getOwnedReminder(c, id, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Not found' }, 404);
    if (!await deleteReminder(c.env.DB, id, scope)) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== リマインダステップ =============

reminders.post('/api/reminders/:id/steps', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const reminderId = c.req.param('id');
    const reminder = await getOwnedReminder(c, reminderId, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    const body = await c.req.json<{
      offsetMinutes?: unknown;
      messageType?: unknown;
      messageContent?: unknown;
    }>();
    if (
      typeof body.offsetMinutes !== 'number'
      || !Number.isFinite(body.offsetMinutes)
      || typeof body.messageType !== 'string'
      || !body.messageType
      || typeof body.messageContent !== 'string'
      || !body.messageContent
    ) {
      return c.json({ success: false, error: 'offsetMinutes, messageType, messageContent are required' }, 400);
    }
    const step = await createReminderStep(c.env.DB, {
      reminderId,
      offsetMinutes: body.offsetMinutes,
      messageType: body.messageType,
      messageContent: body.messageContent,
      tenantId: scope.tenantId,
      staffId: scope.staffId,
    });
    if (!step) return c.json({ success: false, error: 'Reminder not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: step.id,
        reminderId: step.reminder_id,
        offsetMinutes: step.offset_minutes,
        messageType: step.message_type,
        createdAt: step.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/reminders/:id/steps error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/reminders/:reminderId/steps/:stepId', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const reminderId = c.req.param('reminderId');
    const reminder = await getOwnedReminder(c, reminderId, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    if (!await deleteReminderStep(c.env.DB, reminderId, c.req.param('stepId'), scope)) {
      return c.json({ success: false, error: 'Step not found' }, 404);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/reminders/:reminderId/steps/:stepId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 友だちリマインダ登録 =============

reminders.post('/api/reminders/:id/enroll/:friendId', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const reminderId = c.req.param('id');
    const friendId = c.req.param('friendId');
    const body = await c.req.json<{ targetDate?: unknown }>();
    if (typeof body.targetDate !== 'string' || !body.targetDate) {
      return c.json({ success: false, error: 'targetDate is required' }, 400);
    }

    const reminder = await getOwnedReminder(c, reminderId, scope.tenantId);
    if (!reminder) return c.json({ success: false, error: 'Reminder not found' }, 404);
    const friend = await getFriendById(c.env.DB, friendId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    const lineAccountId = reminder.line_account_id;
    if (!lineAccountId || friend.line_account_id !== lineAccountId) {
      return c.json({ success: false, error: 'Reminder not found' }, 404);
    }

    const enrollment = await enrollFriendInReminder(c.env.DB, {
      friendId,
      reminderId,
      targetDate: body.targetDate,
      tenantId: scope.tenantId,
      staffId: scope.staffId,
    });
    if (!enrollment) return c.json({ success: false, error: 'Reminder not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: enrollment.id,
        friendId: enrollment.friend_id,
        reminderId: enrollment.reminder_id,
        targetDate: enrollment.target_date,
        status: enrollment.status,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/reminders/:id/enroll/:friendId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.get('/api/friends/:friendId/reminders', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const friendId = c.req.param('friendId');
    const friend = await getFriendById(c.env.DB, friendId);
    if (!friend?.line_account_id) return c.json({ success: false, error: 'Friend not found' }, 404);
    if (!await accountResourceOwnedByStaff(c, scope.tenantId, friend.line_account_id)) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }
    const items = await getFriendReminders(c.env.DB, friendId, scope.tenantId);
    return c.json({
      success: true,
      data: items.map((fr) => ({
        id: fr.id,
        friendId: fr.friend_id,
        reminderId: fr.reminder_id,
        targetDate: fr.target_date,
        status: fr.status,
        createdAt: fr.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/friends/:friendId/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

reminders.delete('/api/friend-reminders/:id', async (c) => {
  try {
    const scope = resolveReminderScope(c);
    if (!scope) return c.json({ success: false, error: 'Tenant context required' }, 401);

    const id = c.req.param('id');
    const friendReminder = await getFriendReminderById(c.env.DB, id, scope.tenantId);
    if (!friendReminder?.line_account_id) {
      return c.json({ success: false, error: 'Friend reminder not found' }, 404);
    }
    if (!await accountResourceOwnedByStaff(c, scope.tenantId, friendReminder.line_account_id)) {
      return c.json({ success: false, error: 'Friend reminder not found' }, 404);
    }
    if (!await cancelFriendReminder(c.env.DB, id, scope)) {
      return c.json({ success: false, error: 'Friend reminder not found' }, 404);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friend-reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { reminders };
