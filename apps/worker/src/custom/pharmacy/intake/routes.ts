import { Hono } from 'hono';
import { getPharmacyAccountId } from '../account.js';
import { readJsonObject } from '../json.js';
import type { Env } from '../../../index.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { hasPharmacyCapability } from '../growth-loop/access.js';
import {
  resolvePrescriptionPatient,
  type PrescriptionPatient,
} from '../prescriptions/patient.js';
import {
  archivePharmacyPatient,
  createPatientIntakeResponse,
  createPharmacyPatient,
  getAdminPharmacyPatient,
  getAdminPharmacyPatientHistory,
  getLatestAdminPatientIntake,
  getLatestPatientIntake,
  getPatientAccessState,
  getPharmacyPatient,
  listAdminPharmacyPatients,
  listPharmacyPatients,
  PATIENT_PROXY_TERMS_HASH,
  PATIENT_PROXY_TERMS_VERSION,
  revokePatientProxyGrant,
  setPatientPrivacyConsent,
  suspendPatientBinding,
  updatePharmacyPatient,
} from './repository.js';
import { canAccessPharmacyOperationsAccount } from '../operations-access.js';
import { resolvePatientIntakeCryptoScope } from './envelopes.js';
import { recordTenantAudit } from '../../../lib/tenant-audit.js';

type IntakeBindings = {
  DB: D1Database;
  LINE_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_ID?: string;
  PHARMACY_PHI_KEY_V1?: string;
  PHARMACY_PHI_KEY_V2?: string;
  PHARMACY_PHI_ACTIVE_KEY_VERSION?: string;
};

type IntakeEnv = {
  Bindings: IntakeBindings;
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    pharmacyPatient: PrescriptionPatient;
    pharmacyTenantId: string;
    tenantId: string;
  };
};

export const pharmacyIntakeRoutes = new Hono<IntakeEnv>();

function auditPhiView(
  c: { env: IntakeBindings; get(name: 'staff'): IntakeEnv['Variables']['staff'] | undefined },
  lineAccountId: string,
  patientId: string,
  action: string,
): Promise<void> {
  return recordTenantAudit(c.env.DB, {
    lineAccountId, actorStaffId: c.get('staff')!.id, action,
    resourceType: 'pharmacy_patient', resourceId: patientId,
  });
}

async function canUseAdminIntake(c: { env: IntakeBindings; get(name: 'staff'): IntakeEnv['Variables']['staff'] | undefined }, accountId: string): Promise<boolean> {
  const staff = c.get('staff');
  return Boolean(staff && await canAccessPharmacyOperationsAccount(c.env.DB, staff, accountId, c.env.LINE_CHANNEL_ID));
}
pharmacyIntakeRoutes.use('/api/custom/pharmacy/patients', async (c, next) => {
  const staff = c.get('staff');
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  return next();
});
pharmacyIntakeRoutes.use('/api/custom/pharmacy/patients/*', async (c, next) => {
  const staff = c.get('staff');
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await canAccessPharmacyOperationsAccount(
    c.env.DB, staff, lineAccountId, c.env.LINE_CHANNEL_ID,
  ))) return c.json({ error: 'Forbidden' }, 403);
  return next();
});

pharmacyIntakeRoutes.use('/api/liff/pharmacy/patients/*', async (c, next) => {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return c.json({ error: 'Unauthorized' }, 401);
  const patient = await resolvePrescriptionPatient(
    c.env.DB,
    c.req.query('liffId') ?? '',
    identity,
  );
  if (!patient) return c.json({ error: 'Pharmacy account not found' }, 404);
  c.set('pharmacyPatient', patient);
  c.set('pharmacyTenantId', identity.tenantId);
  return next();
});

function parseJsonError(error: unknown): { error: string; status: 400 | 403 | 404 | 409 } | null {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid ')) return { error: 'Invalid input', status: 400 };
  if (message === 'intake consent required') {
    return { error: 'Both representative and privacy consent are required', status: 400 };
  }
  if (message === 'patient not found') return { error: 'Patient not found', status: 404 };
  if (message === 'proxy grant required') {
    return { error: 'Family patient access requires an active proxy grant', status: 403 };
  }
  if (message === 'proxy consent required') {
    return { error: 'Current proxy terms consent is required', status: 400 };
  }
  if (message === 'adult family verification required') {
    return { error: 'Adult family access requires pharmacy verification', status: 403 };
  }
  if (message === 'privacy policy required') {
    return { error: 'Privacy policy is not configured', status: 409 };
  }
  if (message === 'privacy policy changed') {
    return { error: 'Privacy policy changed; retry', status: 409 };
  }
  if (message === 'privacy consent withdrawn') {
    return { error: 'Privacy consent was withdrawn; re-consent is required', status: 409 };
  }
  if (message === 'FEATURE_DISABLED') {
    return { error: 'Patient intake is not enabled', status: 409 };
  }
  if (message.includes('conflict')) return { error: 'Patient data changed; retry', status: 409 };
  return null;
}

pharmacyIntakeRoutes.get('/api/liff/pharmacy/patients', async (c) => {
  const owner = c.get('pharmacyPatient');
  return c.json({ patients: await listPharmacyPatients(c.env.DB, owner, false) });
});

pharmacyIntakeRoutes.post('/api/liff/pharmacy/patients', async (c) => {
  const owner = c.get('pharmacyPatient');
  if (!(await hasPharmacyCapability(c.env.DB, owner.lineAccountId, 'patient_intake'))) {
    return c.json({ error: 'Patient intake is not enabled', code: 'FEATURE_DISABLED' }, 409);
  }
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  if (['child', 'spouse', 'parent', 'other'].includes(String(body.relationship)) &&
      body.proxyConsent === undefined) {
    return c.json({ error: 'Family patient access requires an active proxy grant' }, 403);
  }
  try {
    const patient = await createPharmacyPatient(c.env.DB, owner, {
      relationship: body.relationship as never,
      name: body.name as string,
      nameKana: body.nameKana as string,
      birthDate: body.birthDate as string,
      sex: (body.sex ?? null) as never,
      contactPhone: (body.contactPhone ?? null) as string | null,
      postalCode: (body.postalCode ?? null) as string | null,
      prefecture: (body.prefecture ?? null) as string | null,
      city: (body.city ?? null) as string | null,
      addressLine1: (body.addressLine1 ?? null) as string | null,
      addressLine2: (body.addressLine2 ?? null) as string | null,
      proxyConsent: body.proxyConsent as never,
      registrationIdempotencyKey: body.registrationIdempotencyKey as string | undefined,
    });
    const access = patient.relationship === 'child'
      ? await getPatientAccessState(c.env.DB, owner, patient.id)
      : null;
    if (patient.relationship === 'child' && !access?.proxyExpiresAt) {
      throw new Error('patient proxy conflict');
    }
    return c.json({
      patient,
      ...(access?.proxyExpiresAt && { proxyGrant: {
        permission: 'patient_intake_v1' as const,
        basis: 'self_attested_guardian' as const,
        expiresAt: access.proxyExpiresAt,
        termsVersion: PATIENT_PROXY_TERMS_VERSION,
        termsHash: PATIENT_PROXY_TERMS_HASH,
      } }),
    }, 201);
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.delete('/api/liff/pharmacy/patients/:id/proxy-grant', async (c) => {
  try {
    return c.json(await revokePatientProxyGrant(
      c.env.DB, c.get('pharmacyPatient'), c.req.param('id'),
    ));
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.get('/api/liff/pharmacy/patients/:id', async (c) => {
  const patient = await getPharmacyPatient(
    c.env.DB, c.get('pharmacyPatient'), c.req.param('id'),
  );
  return patient ? c.json({ patient }) : c.json({ error: 'Patient not found' }, 404);
});

pharmacyIntakeRoutes.get('/api/liff/pharmacy/patients/:id/access', async (c) => {
  const access = await getPatientAccessState(
    c.env.DB, c.get('pharmacyPatient'), c.req.param('id'),
  );
  return access ? c.json({ access }) : c.json({ error: 'Patient not found' }, 404);
});

pharmacyIntakeRoutes.patch('/api/liff/pharmacy/patients/:id', async (c) => {
  if (!(await hasPharmacyCapability(c.env.DB, c.get('pharmacyPatient').lineAccountId, 'patient_intake'))) {
    return c.json({ error: 'Patient intake is not enabled', code: 'FEATURE_DISABLED' }, 409);
  }
  const body = await readJsonObject(c.req);
  if (!body || typeof body.expectedUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
    return c.json({ error: 'Invalid expectedUpdatedAt' }, 400);
  }
  try {
    await updatePharmacyPatient(c.env.DB, c.get('pharmacyPatient'), c.req.param('id'), body.expectedUpdatedAt, {
      relationship: body.relationship as never,
      name: body.name as string,
      nameKana: body.nameKana as string,
      birthDate: body.birthDate as string,
      sex: (body.sex ?? null) as never,
      contactPhone: (body.contactPhone ?? null) as string | null,
      postalCode: (body.postalCode ?? null) as string | null,
      prefecture: (body.prefecture ?? null) as string | null,
      city: (body.city ?? null) as string | null,
      addressLine1: (body.addressLine1 ?? null) as string | null,
      addressLine2: (body.addressLine2 ?? null) as string | null,
    });
    return c.json({ status: 'updated' });
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.get('/api/liff/pharmacy/patients/:id/intake', async (c) => {
  const cryptoScope = resolvePatientIntakeCryptoScope(c.env, c.get('pharmacyTenantId'));
  if (!cryptoScope) return c.json({ error: 'Service unavailable' }, 503);
  const patient = await getPharmacyPatient(
    c.env.DB, c.get('pharmacyPatient'), c.req.param('id'),
  );
  if (!patient) return c.json({ error: 'Patient not found' }, 404);
  return c.json({ intake: await getLatestPatientIntake(
    c.env.DB, c.get('pharmacyPatient'), c.req.param('id'), cryptoScope,
  ) });
});

pharmacyIntakeRoutes.post('/api/liff/pharmacy/patients/:id/privacy-consent', async (c) => {
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  try {
    return c.json(await setPatientPrivacyConsent(
      c.env.DB,
      c.get('pharmacyPatient'),
      c.req.param('id'),
      body as never,
    ));
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.post('/api/liff/pharmacy/patients/:id/intake', async (c) => {
  if (!(await hasPharmacyCapability(c.env.DB, c.get('pharmacyPatient').lineAccountId, 'patient_intake'))) {
    return c.json({ error: 'Patient intake is not enabled', code: 'FEATURE_DISABLED' }, 409);
  }
  const cryptoScope = resolvePatientIntakeCryptoScope(c.env, c.get('pharmacyTenantId'));
  if (!cryptoScope) return c.json({ error: 'Service unavailable' }, 503);
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  try {
    const intake = await createPatientIntakeResponse(
      c.env.DB,
      c.get('pharmacyPatient'),
      c.req.param('id'),
      body as never,
      cryptoScope,
    );
    return c.json({ intake }, 201);
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.post('/api/liff/pharmacy/patients/:id/archive', async (c) => {
  const body = await readJsonObject(c.req);
  if (!body || typeof body.expectedUpdatedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
    return c.json({ error: 'Invalid expectedUpdatedAt' }, 400);
  }
  try {
    await archivePharmacyPatient(
      c.env.DB,
      c.get('pharmacyPatient'),
      c.req.param('id'),
      body.expectedUpdatedAt,
    );
    return c.json({ status: 'archived' });
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.get('/api/custom/pharmacy/patients', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canUseAdminIntake(c, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return c.json({ patients: await listAdminPharmacyPatients(c.env.DB, lineAccountId, true) });
});

pharmacyIntakeRoutes.post('/api/custom/pharmacy/patients/:id/binding-suspension', async (c) => {
  const staff = c.get('staff');
  const lineAccountId = getPharmacyAccountId(c);
  if (!staff) return c.json({ error: 'Unauthorized' }, 401);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  const body = await readJsonObject(c.req);
  if (!body || body.reasonCode !== 'wrong_line_binding') {
    return c.json({ error: 'Invalid input' }, 400);
  }
  try {
    return c.json(await suspendPatientBinding(
      c.env.DB, lineAccountId, c.req.param('id'), staff.id, body.reasonCode,
    ));
  } catch (error) {
    const mapped = parseJsonError(error);
    if (mapped) return c.json({ error: mapped.error }, mapped.status);
    throw error;
  }
});

pharmacyIntakeRoutes.get('/api/custom/pharmacy/patients/:id/history', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canUseAdminIntake(c, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const cryptoScope = resolvePatientIntakeCryptoScope(c.env, c.get('tenantId'));
  if (!cryptoScope) return c.json({ error: 'Service unavailable' }, 503);
  const history = await getAdminPharmacyPatientHistory(
    c.env.DB, lineAccountId, c.req.param('id'), cryptoScope,
  );
  if (!history) return c.json({ error: 'Patient not found' }, 404);
  await auditPhiView(c, lineAccountId, c.req.param('id'), 'phi.intake_history_viewed');
  return c.json({ history });
});

pharmacyIntakeRoutes.get('/api/custom/pharmacy/patients/:id', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canUseAdminIntake(c, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const patient = await getAdminPharmacyPatient(c.env.DB, lineAccountId, c.req.param('id'));
  if (!patient) return c.json({ error: 'Patient not found' }, 404);
  await auditPhiView(c, lineAccountId, c.req.param('id'), 'phi.patient_viewed');
  return c.json({ patient });
});

pharmacyIntakeRoutes.get('/api/custom/pharmacy/patients/:id/intake', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canUseAdminIntake(c, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const patient = await getAdminPharmacyPatient(c.env.DB, lineAccountId, c.req.param('id'));
  if (!patient) return c.json({ error: 'Patient not found' }, 404);
  const cryptoScope = resolvePatientIntakeCryptoScope(c.env, c.get('tenantId'));
  if (!cryptoScope) return c.json({ error: 'Service unavailable' }, 503);
  const intake = await getLatestAdminPatientIntake(
    c.env.DB, lineAccountId, c.req.param('id'), cryptoScope,
  );
  await auditPhiView(c, lineAccountId, c.req.param('id'), 'phi.intake_viewed');
  return c.json({ intake });
});
