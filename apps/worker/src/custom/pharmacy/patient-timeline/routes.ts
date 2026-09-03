import { Hono } from 'hono';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { resolvePrescriptionPatient } from '../prescriptions/patient.js';
import { listPatientTimeline } from './repository.js';

type TimelineEnv = { Bindings: { DB: D1Database } };

export const patientTimelineRoutes = new Hono<TimelineEnv>();

patientTimelineRoutes.get('/api/liff/pharmacy/timeline', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(
    c.env.DB,
    c.req.query('liffId') ?? '',
    identity,
  );
  if (!patient) return c.json({ error: 'Patient account not found' }, 404);
  return c.json({ items: await listPatientTimeline(c.env.DB, patient) });
});
