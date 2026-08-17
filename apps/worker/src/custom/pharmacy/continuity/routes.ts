import { Hono } from 'hono';
import { getPharmacyAccountId } from '../account.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { resolvePrescriptionPatient, type PrescriptionPatient } from '../prescriptions/patient.js';
import { listContinuityObligations, listPatientContinuity, pausePatientContinuity } from './repository.js';

type ContinuityEnv = {
  Bindings: { DB: D1Database; LINE_LOGIN_CHANNEL_ID?: string };
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    continuityPatient: PrescriptionPatient;
  };
};

export const continuityRoutes = new Hono<ContinuityEnv>();

continuityRoutes.use('/api/liff/pharmacy/continuity/*', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(c.env.DB, c.req.query('liffId') ?? '', identity);
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  c.set('continuityPatient', patient);
  return next();
});

continuityRoutes.get('/api/liff/pharmacy/continuity', async (c) => {
  const patient = c.get('continuityPatient');
  return c.json({ obligations: await listPatientContinuity(c.env.DB, patient.lineAccountId, patient.friendId) });
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
  return c.json({ obligations: await listContinuityObligations(c.env.DB, account) });
});
