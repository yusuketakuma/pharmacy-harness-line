import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../index.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { readJsonObject } from '../json.js';
import { canAccessPharmacyAccount, hasPharmacyCapability } from '../growth-loop/access.js';
import {
  resolvePrescriptionPatient,
  type PrescriptionPatient,
} from '../prescriptions/patient.js';
import {
  listOwnerMedicationFollowUps,
  respondToMedicationFollowUp,
  scheduleMedicationFollowUp,
  transitionMedicationFollowUp,
  type MedicationFollowUp,
  type MedicationFollowUpPatientResponse,
  type MedicationFollowUpStatus,
  type PatientMedicationFollowUp,
} from './repository.js';

type MedicationFollowUpEnv = {
  Bindings: Env['Bindings'];
  Variables: Env['Variables'] & { medicationFollowUpPatient: PrescriptionPatient };
};

export const medicationFollowUpRoutes = new Hono<MedicationFollowUpEnv>();

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

function patientProjection(row: PatientMedicationFollowUp) {
  return {
    id: row.id,
    patient_name: row.patient_name,
    status: row.status,
    due_at: row.due_at,
    delivered_at: row.delivered_at,
    responded_at: row.responded_at,
    closed_at: row.closed_at,
    version: row.version,
  };
}

medicationFollowUpRoutes.use('/api/liff/pharmacy/medication-followups/*', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(
    c.env.DB, c.req.query('liffId') ?? '', identity,
  );
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  if (!(await hasPharmacyCapability(c.env.DB, patient.lineAccountId, 'medication_followup'))) {
    return c.json({ error: 'Medication follow-up is not enabled' }, 403);
  }
  c.set('medicationFollowUpPatient', patient);
  return next();
});

medicationFollowUpRoutes.get('/api/liff/pharmacy/medication-followups', async (c) => {
  const owner = c.get('medicationFollowUpPatient');
  const followUps = await listOwnerMedicationFollowUps(
    c.env.DB, owner.lineAccountId, owner.friendId,
  );
  return c.json({ followUps: followUps.map(patientProjection) });
});

medicationFollowUpRoutes.post('/api/liff/pharmacy/medication-followups/:id/respond', async (c) => {
  const owner = c.get('medicationFollowUpPatient');
  const body = await readJsonObject(c.req);
  const response = body?.response as MedicationFollowUpPatientResponse | undefined;
  if (!body || !['no_issue', 'concern', 'pharmacist_requested'].includes(response ?? '') ||
      typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string') {
    return c.json({ error: '回答を確認できませんでした' }, 400);
  }
  try {
    const followUp = await respondToMedicationFollowUp(c.env.DB, {
      lineAccountId: owner.lineAccountId,
      friendId: owner.friendId,
      followUpId: c.req.param('id'),
      response: response!,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
    });
    const updated = (await listOwnerMedicationFollowUps(
      c.env.DB, owner.lineAccountId, owner.friendId,
    )).find((item) => item.id === followUp.id);
    if (!updated) return c.json({ error: '回答を保存できませんでした' }, 409);
    return c.json({ followUp: patientProjection(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return c.json({ error: '回答を保存できませんでした' }, /conflict/i.test(message) ? 409 : 400);
  }
});

async function scope(c: Context<MedicationFollowUpEnv>): Promise<{
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
