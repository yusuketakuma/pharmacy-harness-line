import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../index.js';
import { readJsonObject } from '../json.js';
import { canAccessPharmacyAccount, hasPharmacyCapability } from '../growth-loop/access.js';
import {
  scheduleMedicationFollowUp,
  transitionMedicationFollowUp,
  type MedicationFollowUp,
  type MedicationFollowUpStatus,
} from './repository.js';

export const medicationFollowUpRoutes = new Hono<Env>();

const STAFF_TRANSITIONS = new Set<MedicationFollowUpStatus>([
  'assigned', 'responded', 'escalated', 'closed', 'cancelled',
]);

function adminProjection(row: MedicationFollowUp) {
  return {
    id: row.id,
    source_submission_id: row.source_submission_id,
    status: row.status,
    due_at: row.due_at,
    delivered_at: row.delivered_at,
    responded_at: row.responded_at,
    closed_at: row.closed_at,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function scope(c: Context<Env>): Promise<{
  lineAccountId: string;
  staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
} | Response> {
  const lineAccountId = c.req.query('line_account_id');
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyAccount(c.env.DB, staff, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!(await hasPharmacyCapability(c.env.DB, lineAccountId, 'medication_followup'))) {
    return c.json({ error: 'pharmacy capability is not enabled' }, 403);
  }
  return { lineAccountId, staff };
}

medicationFollowUpRoutes.post('/api/custom/pharmacy/medication-followups', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const body = await readJsonObject(c.req);
  if (!body || typeof body.submissionId !== 'string' || typeof body.dueAt !== 'string' ||
      typeof body.idempotencyKey !== 'string') {
    return c.json({ error: 'submissionId, dueAt, and idempotencyKey are required' }, 400);
  }
  try {
    const followUp = await scheduleMedicationFollowUp(c.env.DB, {
      lineAccountId: account.lineAccountId,
      submissionId: body.submissionId,
      dueAt: body.dueAt,
      staffId: account.staff.id,
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ followUp: adminProjection(followUp) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'medication follow-up scheduling failed';
    return c.json({ error: message }, /already|conflict/i.test(message) ? 409 : 400);
  }
});

medicationFollowUpRoutes.post('/api/custom/pharmacy/medication-followups/:id/transitions', async (c) => {
  const account = await scope(c);
  if (account instanceof Response) return account;
  const body = await readJsonObject(c.req);
  if (!body || typeof body.status !== 'string' || !STAFF_TRANSITIONS.has(body.status as MedicationFollowUpStatus) ||
      typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
    return c.json({ error: 'valid status and expectedVersion are required' }, 400);
  }
  try {
    const followUp = await transitionMedicationFollowUp(c.env.DB, {
      lineAccountId: account.lineAccountId,
      followUpId: c.req.param('id'),
      toStatus: body.status as MedicationFollowUpStatus,
      expectedVersion: body.expectedVersion,
      actorType: 'staff',
      actorId: account.staff.id,
    });
    return c.json({ followUp: adminProjection(followUp) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'medication follow-up update failed';
    const status = /not found/i.test(message) ? 404 : /conflict/i.test(message) ? 409 : 400;
    return c.json({ error: message }, status);
  }
});
