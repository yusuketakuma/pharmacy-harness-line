import { Hono } from 'hono';
import type { Env } from '../../../index.js';
import { readJsonObject } from '../json.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { resolvePrescriptionPatient } from '../prescriptions/patient.js';
import {
  getEffectiveTenantPrivacyPolicy,
  getTenantPrivacyPolicy,
  saveTenantPrivacyPolicy,
} from './repository.js';

type PrivacyPolicyEnv = {
  Bindings: Env['Bindings'];
  Variables: Env['Variables'] & { privacyPolicyLineAccountId: string };
};

export const pharmacyPrivacyPolicyRoutes = new Hono<PrivacyPolicyEnv>();

pharmacyPrivacyPolicyRoutes.use('/api/liff/pharmacy/privacy-policy', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(c.env.DB, c.req.query('liffId') ?? '', identity);
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  c.set('privacyPolicyLineAccountId', patient.lineAccountId);
  return next();
});

// Patient intake receives either the tenant-authored notice or the immutable baseline.
pharmacyPrivacyPolicyRoutes.get('/api/liff/pharmacy/privacy-policy', async (c) => {
  const policy = await getEffectiveTenantPrivacyPolicy(
    c.env.DB,
    c.get('privacyPolicyLineAccountId'),
  );
  return c.json({
    policy: policy && {
      purpose_text: policy.purpose_text,
      purpose_url: policy.purpose_url,
      contact_point: policy.contact_point,
      entrustment_text: policy.entrustment_text,
      policy_version: policy.policy_version,
      content_hash: policy.content_hash,
    },
  });
});

pharmacyPrivacyPolicyRoutes.get('/api/custom/pharmacy/privacy-policy', async (c) => {
  const lineAccountId = c.get('pharmacyLineAccountId');
  if (!lineAccountId || !c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ policy: await getTenantPrivacyPolicy(c.env.DB, lineAccountId) });
});

pharmacyPrivacyPolicyRoutes.put('/api/custom/pharmacy/privacy-policy', async (c) => {
  const lineAccountId = c.get('pharmacyLineAccountId');
  const staff = c.get('staff');
  if (!lineAccountId || !staff) return c.json({ error: 'Unauthorized' }, 401);
  if (staff.role !== 'owner' && staff.role !== 'admin') return c.json({ error: 'Forbidden' }, 403);
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: '入力内容を確認してください' }, 400);
  try {
    await saveTenantPrivacyPolicy(c.env.DB, {
      lineAccountId,
      staffId: staff.id,
      purposeText: String(body.purposeText ?? ''),
      purposeUrl: String(body.purposeUrl ?? ''),
      contactPoint: String(body.contactPoint ?? ''),
      entrustmentText: String(body.entrustmentText ?? ''),
    });
    return c.body(null, 204);
  } catch {
    return c.json({ error: '入力内容を確認してください' }, 400);
  }
});
