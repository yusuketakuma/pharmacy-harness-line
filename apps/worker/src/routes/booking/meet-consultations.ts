import { Hono } from 'hono';
import type { Env } from '../../index.js';
import {
  cancelMeetConsultation,
  listMeetConsultations,
  registerMeetConsultation,
  type MeetConsultationStatus,
  type RegisterMeetConsultationInput,
} from '../../services/meet-consultation-reminders.js';

const meetConsultations = new Hono<Env>();

async function tenantFriendAccount(
  db: D1Database,
  tenantId: string,
  friendId: string,
): Promise<string | null> {
  const row = await db.prepare(`SELECT friend.line_account_id
    FROM friends friend
    INNER JOIN tenant_line_accounts mapping ON mapping.line_account_id = friend.line_account_id
    WHERE friend.id = ? AND mapping.tenant_id = ? LIMIT 1`)
    .bind(friendId, tenantId).first<{ line_account_id: string }>();
  return row?.line_account_id ?? null;
}

async function tenantConsultationAccount(
  db: D1Database,
  tenantId: string,
  externalEventId: string,
): Promise<string | null> {
  const row = await db.prepare(`SELECT friend.line_account_id
    FROM meet_consultations consultation
    INNER JOIN friends friend ON friend.id = consultation.friend_id
    INNER JOIN tenant_line_accounts mapping ON mapping.line_account_id = friend.line_account_id
    WHERE consultation.external_event_id = ? AND mapping.tenant_id = ? LIMIT 1`)
    .bind(externalEventId, tenantId).first<{ line_account_id: string }>();
  return row?.line_account_id ?? null;
}

meetConsultations.get('/api/meet-consultations', async (c) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return c.json({ success: false, error: 'tenant scope required' }, 403);
  const status = c.req.query('status') ?? 'confirmed';
  if (!['confirmed', 'cancelled', 'completed', 'all'].includes(status)) {
    return c.json({ success: false, error: 'invalid status' }, 400);
  }
  const data = await listMeetConsultations(c.env.DB, tenantId, status as MeetConsultationStatus);
  return c.json({ success: true, data });
});

meetConsultations.post('/api/meet-consultations', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return c.json({ success: false, error: 'tenant scope required' }, 403);
    const body = await c.req.json<RegisterMeetConsultationInput>();
    if (typeof body.friendId !== 'string') throw new Error('friendId is required');
    const lineAccountId = await tenantFriendAccount(c.env.DB, tenantId, body.friendId);
    if (!lineAccountId) return c.json({ success: false, error: 'friend not found or not following' }, 404);
    const registered = await registerMeetConsultation(c.env.DB, body, lineAccountId);
    return c.json({ success: true, data: registered }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'friend not found or not following' ? 404 : 400;
    return c.json({ success: false, error: message }, status);
  }
});

meetConsultations.delete('/api/meet-consultations/:externalEventId', async (c) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return c.json({ success: false, error: 'tenant scope required' }, 403);
  const externalEventId = c.req.param('externalEventId');
  const lineAccountId = await tenantConsultationAccount(c.env.DB, tenantId, externalEventId);
  if (!lineAccountId) return c.json({ success: false, error: 'consultation not found' }, 404);
  const cancelled = await cancelMeetConsultation(c.env.DB, externalEventId, lineAccountId);
  if (!cancelled) return c.json({ success: false, error: 'consultation not found' }, 404);
  return c.json({ success: true, data: null });
});

export { meetConsultations };
