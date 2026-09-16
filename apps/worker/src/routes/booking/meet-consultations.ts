import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../index.js';
import {
  cancelMeetConsultation,
  listMeetConsultations,
  meetJstDateTime,
  registerMeetConsultation,
  type MeetConsultationStatus,
  type RegisterMeetConsultationInput,
} from '../../services/meet-consultation-reminders.js';
import {
  hasPharmacyCapability,
  resolveAccessiblePharmacyTenant,
} from '../../custom/pharmacy/growth-loop/access.js';
import { readLineCredential } from '../../custom/pharmacy/provisioning/line-credential-store.js';
import { sendPharmacyAutomatedPush } from '../../custom/pharmacy/growth-loop/sender.js';
import { lineProxy } from '../integrations/line-proxy.js';

const meetConsultations = new Hono<Env>();
const REGISTRATION_INPUT_ERRORS = new Set([
  'externalEventId is required',
  'friendId is required',
  'title is required',
  'meetUrl must be a Google Meet URL',
  'startsAt must be a valid ISO datetime',
  'endsAt must be a valid ISO datetime',
  'endsAt must be after startsAt',
  'startsAt must be in the future',
]);

async function assignedToAccount(
  db: D1Database,
  staff: { id: string; role: 'owner' | 'admin' | 'staff' } | undefined,
  tenantId: string,
  lineAccountId: string,
): Promise<boolean> {
  return await resolveAccessiblePharmacyTenant(db, staff, lineAccountId) === tenantId;
}

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
  const lineAccountId = c.req.query('line_account_id');
  if (!lineAccountId) return c.json({ success: false, error: 'line_account_id is required' }, 400);
  if (!await assignedToAccount(c.env.DB, c.get('staff'), tenantId, lineAccountId)) {
    return c.json({ success: false, error: 'account access denied' }, 403);
  }
  const status = c.req.query('status') ?? 'confirmed';
  if (!['confirmed', 'cancelled', 'completed', 'all'].includes(status)) {
    return c.json({ success: false, error: 'invalid status' }, 400);
  }
  const data = await listMeetConsultations(
    c.env.DB, tenantId, lineAccountId, status as MeetConsultationStatus,
  );
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
    if (!await assignedToAccount(c.env.DB, c.get('staff'), tenantId, lineAccountId)) {
      return c.json({ success: false, error: 'account access denied' }, 403);
    }
    const registered = await registerMeetConsultation(c.env.DB, body, lineAccountId);
    // Best-effort confirmation push on pharmacy accounts with the capability.
    // Registration is already committed, so a notification failure must not
    // turn this into an error response.
    const confirmationSent = await sendMeetConfirmation(
      c, tenantId, lineAccountId, body.friendId, body.meetUrl, registered,
    );
    return c.json({ success: true, data: { ...registered, confirmationSent } }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'friend not found or not following') {
      return c.json({ success: false, error: message }, 404);
    }
    if (message === 'consultation account scope conflict') {
      return c.json({ success: false, error: message }, 409);
    }
    if (error instanceof SyntaxError || REGISTRATION_INPUT_ERRORS.has(message)) {
      return c.json({ success: false, error: error instanceof SyntaxError ? 'invalid consultation' : message }, 400);
    }
    return c.json({ success: false, error: 'consultation registration failed' }, 503);
  }
});

async function sendMeetConfirmation(
  c: Context<Env>,
  tenantId: string,
  lineAccountId: string,
  friendId: string,
  meetUrl: string,
  registered: { id: string; startsAt: string },
): Promise<boolean> {
  try {
    if (!await hasPharmacyCapability(c.env.DB, lineAccountId, 'meet_consultation')) {
      return false;
    }
    const friend = await c.env.DB.prepare(
      `SELECT provider_line_user_id AS line_user_id FROM friends
        WHERE id = ? AND line_account_id = ? AND is_following = 1 LIMIT 1`,
    ).bind(friendId, lineAccountId).first<{ line_user_id: string | null }>();
    const accessToken = c.env.LINE_CREDENTIAL_KEY_V1 && friend?.line_user_id
      ? await readLineCredential(c.env.DB, c.env.LINE_CREDENTIAL_KEY_V1, {
          tenantId, lineAccountId, kind: 'channel_access_token' })
      : null;
    if (!friend?.line_user_id || !accessToken) return false;
    const { genericDate, genericTime } = meetJstDateTime(registered.startsAt);
    const outcome = await sendPharmacyAutomatedPush({
      db: c.env.DB,
      proxyBaseUrl: c.env.WORKER_PUBLIC_URL ?? new URL(c.req.url).origin,
      proxyDispatch: (request: Request) => Promise.resolve(
        lineProxy.fetch(request, c.env as Env['Bindings']),
      ),
      accessToken,
      to: friend.line_user_id,
      lineAccountId,
      friendId,
      messageId: 'meet_consultation_v1',
      category: 'transactional_care',
      vars: {
        meetStatus: 'scheduled',
        genericDate,
        genericTime,
        meetUrl,
      },
      // The startsAt component lets a rescheduled consultation send a fresh
      // confirmation while a duplicate registration dedupes.
      retryKey: `meet-confirmation:${registered.id}:${registered.startsAt}`,
    });
    return outcome === 'sent' || outcome === 'already_sent';
  } catch {
    return false;
  }
}

meetConsultations.delete('/api/meet-consultations/:externalEventId', async (c) => {
  const tenantId = c.get('tenantId');
  if (!tenantId) return c.json({ success: false, error: 'tenant scope required' }, 403);
  const externalEventId = c.req.param('externalEventId');
  const lineAccountId = await tenantConsultationAccount(c.env.DB, tenantId, externalEventId);
  if (!lineAccountId) return c.json({ success: false, error: 'consultation not found' }, 404);
  if (!await assignedToAccount(c.env.DB, c.get('staff'), tenantId, lineAccountId)) {
    return c.json({ success: false, error: 'account access denied' }, 403);
  }
  const cancelled = await cancelMeetConsultation(c.env.DB, externalEventId, lineAccountId);
  if (!cancelled) return c.json({ success: false, error: 'consultation not found' }, 404);
  return c.json({ success: true, data: null });
});

export { meetConsultations };
