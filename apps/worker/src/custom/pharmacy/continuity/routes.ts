import { Hono } from 'hono';
import { getPharmacyAccountId } from '../account.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { resolvePrescriptionPatient, type PrescriptionPatient } from '../prescriptions/patient.js';
import { listContinuityObligations, listPatientContinuity, pausePatientContinuity } from './repository.js';
import { readJsonObject } from '../json.js';
import {
  listPatientExpectations,
  listAccountExpectations,
  endNextIntakeExpectation,
  offerNextIntakeExpectation,
  respondToNextIntakeExpectation,
  type NextIntakeExpectation,
} from './next-intake.js';
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';

type ContinuityEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ID?: string; LINE_LOGIN_CHANNEL_ID?: string };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    continuityPatient: PrescriptionPatient;
  };
};

export const continuityRoutes = new Hono<ContinuityEnv>();

function expectationView(item: NextIntakeExpectation) {
  return {
    id: item.id,
    obligation_id: item.obligation_id,
    patient_id: item.patient_id,
    status: item.status,
    timing_source: item.timing_source,
    supply_days: item.supply_days,
    expected_from: item.expected_from,
    expected_to: item.expected_to,
    reminder_at: item.reminder_at,
    reminded_at: item.reminded_at,
    version: item.version,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}
// Wildcard also matches the bare collection path, so child routes such as
// POST /continuity/:id/expectations run the same account + capability gate.
continuityRoutes.use('/api/custom/pharmacy/continuity/*', async (c, next) => {
  const staff = c.get('staff');
  const account = getPharmacyAccountId(c);
  if (!account) return c.json({ error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, account, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  if (!(await hasPharmacyCapability(c.env.DB, account, 'continuity'))) {
    return c.json({ error: 'Continuity is not enabled' }, 403);
  }
  return next();
});

continuityRoutes.use('/api/liff/pharmacy/continuity/*', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(c.env.DB, c.req.query('liffId') ?? '', identity);
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  if (!(await hasPharmacyCapability(c.env.DB, patient.lineAccountId, 'continuity'))) {
    return c.json({ error: 'Continuity is not enabled' }, 403);
  }
  c.set('continuityPatient', patient);
  return next();
});

continuityRoutes.get('/api/liff/pharmacy/continuity', async (c) => {
  const patient = c.get('continuityPatient');
  const [obligations, expectations] = await Promise.all([
    listPatientContinuity(c.env.DB, patient.lineAccountId, patient.friendId),
    listPatientExpectations(c.env.DB, patient.lineAccountId, patient.friendId),
  ]);
  return c.json({ obligations, expectations: expectations.map(expectationView) });
});

continuityRoutes.post('/api/liff/pharmacy/continuity/expectations/:id/respond', async (c) => {
  const patient = c.get('continuityPatient');
  const body = await readJsonObject(c.req);
  if (!body || (body.response !== 'accepted' && body.response !== 'ended') ||
      typeof body.idempotencyKey !== 'string') {
    return c.json({ error: 'Invalid response' }, 400);
  }
  try {
    const expectation = await respondToNextIntakeExpectation(c.env.DB, {
      lineAccountId: patient.lineAccountId,
      friendId: patient.friendId,
      expectationId: c.req.param('id'),
      response: body.response,
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ expectation: expectationView(expectation) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return c.json({ error: '次回事前送信のお知らせを変更できませんでした' },
      /conflict/i.test(message) ? 409 : 400);
  }
});

continuityRoutes.post('/api/liff/pharmacy/continuity/:id/pause', async (c) => {
  const patient = c.get('continuityPatient');
  try {
    await pausePatientContinuity(c.env.DB, patient.lineAccountId, patient.friendId, c.req.param('id'));
    return c.json({ status: 'paused' });
  } catch (error) {
    if (error instanceof Error && error.message === 'continuity pause conflict') {
      return c.json({ error: '継続フォローの状態が変わりました' }, 409);
    }
    throw error;
  }
});

continuityRoutes.get('/api/custom/pharmacy/continuity', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const account = getPharmacyAccountId(c);
  if (!account) return c.json({ error: 'line_account_id is required' }, 400);
  const [obligations, expectations] = await Promise.all([
    listContinuityObligations(c.env.DB, account),
    listAccountExpectations(c.env.DB, account),
  ]);
  return c.json({ obligations, expectations: expectations.map(expectationView) });
});

continuityRoutes.post('/api/custom/pharmacy/continuity/:id/expectations', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const account = getPharmacyAccountId(c);
  if (!account) return c.json({ error: 'line_account_id is required' }, 400);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.idempotencyKey !== 'string') {
    return c.json({ error: 'Invalid next-intake offer' }, 400);
  }
  const timing = body.timingSource === 'manual_supply_days' &&
      typeof body.supplyDays === 'number' && Number.isInteger(body.supplyDays)
    ? { source: 'manual_supply_days' as const, supplyDays: body.supplyDays }
    : body.timingSource === 'manual_window' && typeof body.expectedFrom === 'string' &&
        typeof body.expectedTo === 'string' && typeof body.reminderAt === 'string'
      ? {
        source: 'manual_window' as const,
        expectedFrom: body.expectedFrom,
        expectedTo: body.expectedTo,
        reminderAt: body.reminderAt,
      }
      : null;
  if (!timing) return c.json({ error: 'Invalid next-intake timing' }, 400);
  try {
    const expectation = await offerNextIntakeExpectation(c.env.DB, {
      lineAccountId: account,
      obligationId: c.req.param('id'),
      timing,
      staffId: staff.id,
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ expectation: expectationView(expectation) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return c.json({ error: '次回事前送信のお知らせを登録できませんでした' },
      /already|conflict/i.test(message) ? 409 : 400);
  }
});

continuityRoutes.post('/api/custom/pharmacy/continuity/:id/expectations/:expectationId/end', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  const account = getPharmacyAccountId(c);
  if (!account) return c.json({ error: 'line_account_id is required' }, 400);
  const body = await readJsonObject(c.req);
  if (!body || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string') {
    return c.json({ error: 'expectedVersion and idempotencyKey are required' }, 400);
  }
  try {
    const expectation = await endNextIntakeExpectation(c.env.DB, {
      lineAccountId: account,
      expectationId: c.req.param('expectationId'),
      expectedVersion: body.expectedVersion,
      staffId: staff.id,
      idempotencyKey: body.idempotencyKey,
    });
    return c.json({ expectation: expectationView(expectation) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return c.json({ error: '次回事前送信のお知らせを取り消せませんでした' },
      /conflict/i.test(message) ? 409 : 400);
  }
});
