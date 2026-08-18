import { Hono } from 'hono';
import { getPharmacyAccountId } from '../account.js';
import { readJsonObject } from '../json.js';
import type { Env } from '../../../index.js';
import { verifyCallerLineIdentity } from '../../../services/liff-auth.js';
import { canAccessPharmacyAccount, hasPharmacyCapability } from '../growth-loop/access.js';
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
  getPharmacyPatient,
  listAdminPharmacyPatients,
  listPharmacyPatients,
  updatePharmacyPatient,
} from './repository.js';

type IntakeBindings = {
  DB: D1Database;
  LINE_LOGIN_CHANNEL_ID?: string;
};

type IntakeEnv = {
  Bindings: IntakeBindings;
  Variables: {
    staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
    pharmacyPatient: PrescriptionPatient;
  };
};

export const pharmacyIntakeRoutes = new Hono<IntakeEnv>();

async function canUseAdminIntake(c: { env: { DB: D1Database }; get(name: 'staff'): IntakeEnv['Variables']['staff'] | undefined }, accountId: string): Promise<boolean> {
  const staff = c.get('staff');
  return Boolean(staff && await canAccessPharmacyAccount(c.env.DB, staff, accountId) &&
    await hasPharmacyCapability(c.env.DB, accountId, 'patient_intake'));
}

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
  return next();
});

function parseJsonError(error: unknown): { error: string; status: 400 | 404 | 409 } | null {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('invalid ')) return { error: 'Invalid input', status: 400 };
  if (message === 'intake consent required') {
    return { error: 'Both representative and privacy consent are required', status: 400 };
  }
  if (message === 'patient not found') return { error: 'Patient not found', status: 404 };
  if (message.includes('conflict')) return { error: 'Patient data changed; retry', status: 409 };
  return null;
}

pharmacyIntakeRoutes.get('/api/liff/pharmacy/patients', async (c) => {
  const owner = c.get('pharmacyPatient');
  return c.json({ patients: await listPharmacyPatients(c.env.DB, owner, false) });
});

pharmacyIntakeRoutes.post('/api/liff/pharmacy/patients', async (c) => {
  const owner = c.get('pharmacyPatient');
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
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
    });
    return c.json({ patient }, 201);
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

pharmacyIntakeRoutes.patch('/api/liff/pharmacy/patients/:id', async (c) => {
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
  const patient = await getPharmacyPatient(
    c.env.DB, c.get('pharmacyPatient'), c.req.param('id'),
  );
  if (!patient) return c.json({ error: 'Patient not found' }, 404);
  return c.json({ intake: await getLatestPatientIntake(
    c.env.DB, c.get('pharmacyPatient'), c.req.param('id'),
  ) });
});

pharmacyIntakeRoutes.post('/api/liff/pharmacy/patients/:id/intake', async (c) => {
  const body = await readJsonObject(c.req);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  try {
    const intake = await createPatientIntakeResponse(
      c.env.DB,
      c.get('pharmacyPatient'),
      c.req.param('id'),
      body as never,
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

pharmacyIntakeRoutes.get('/api/custom/pharmacy/patients/:id/history', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canUseAdminIntake(c, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const history = await getAdminPharmacyPatientHistory(c.env.DB, lineAccountId, c.req.param('id'));
  return history ? c.json({ history }) : c.json({ error: 'Patient not found' }, 404);
});

pharmacyIntakeRoutes.get('/api/custom/pharmacy/patients/:id', async (c) => {
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401);
  const lineAccountId = getPharmacyAccountId(c);
  if (!lineAccountId) return c.json({ error: 'line_account_id is required' }, 400);
  if (!(await canUseAdminIntake(c, lineAccountId))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const patient = await getAdminPharmacyPatient(c.env.DB, lineAccountId, c.req.param('id'));
  return patient ? c.json({ patient }) : c.json({ error: 'Patient not found' }, 404);
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
  return c.json({ intake: await getLatestAdminPatientIntake(
    c.env.DB, lineAccountId, c.req.param('id'),
  ) });
});
