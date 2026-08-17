import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolvePatient: vi.fn(),
  listPatients: vi.fn(),
  listAdminPatients: vi.fn(),
  getAdminPatient: vi.fn(),
  getLatestAdminIntake: vi.fn(),
  createPatient: vi.fn(),
  getPatient: vi.fn(),
  createIntake: vi.fn(),
  getLatestIntake: vi.fn(),
  archivePatient: vi.fn(),
  updatePatient: vi.fn(),
  history: vi.fn(),
  access: vi.fn(),
  capability: vi.fn(),
}));

vi.mock('../../../services/liff-auth.js', () => ({
  verifyCallerLineIdentity: mocks.verify,
}));
vi.mock('../prescriptions/patient.js', () => ({
  resolvePrescriptionPatient: mocks.resolvePatient,
}));
vi.mock('./repository.js', () => ({
  listPharmacyPatients: mocks.listPatients,
  listAdminPharmacyPatients: mocks.listAdminPatients,
  createPharmacyPatient: mocks.createPatient,
  getPharmacyPatient: mocks.getPatient,
  createPatientIntakeResponse: mocks.createIntake,
  getLatestPatientIntake: mocks.getLatestIntake,
  archivePharmacyPatient: mocks.archivePatient,
  updatePharmacyPatient: mocks.updatePatient,
  getAdminPharmacyPatientHistory: mocks.history,
  getAdminPharmacyPatient: mocks.getAdminPatient,
  getLatestAdminPatientIntake: mocks.getLatestAdminIntake,
}));
vi.mock('../growth-loop/access.js', () => ({
  canAccessPharmacyAccount: mocks.access,
  hasPharmacyCapability: mocks.capability,
}));

import { pharmacyIntakeRoutes } from './routes.js';

const env = { DB: {} as D1Database };
const owner = { lineAccountId: 'account-1', friendId: 'friend-1' };

function adminApp() {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; name: string; role: 'admin' } };
  }>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
    await next();
  });
  app.route('/', pharmacyIntakeRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
  mocks.resolvePatient.mockResolvedValue(owner);
  mocks.listPatients.mockResolvedValue([{ id: 'patient-1', relationship: 'self' }]);
  mocks.listAdminPatients.mockResolvedValue([{ id: 'patient-1', relationship: 'self' }]);
  mocks.getAdminPatient.mockResolvedValue({ id: 'patient-1', relationship: 'self' });
  mocks.getLatestAdminIntake.mockResolvedValue({
    id: 'response-1', patient_id: 'patient-1', revision: 1, schema_version: 2,
    representative_consent_at: '2026-08-17T00:00:00Z',
    privacy_consent_at: '2026-08-17T00:00:00Z', created_at: '2026-08-17T00:00:00Z',
    answers: { allergiesStatus: 'none' },
  });
  mocks.createPatient.mockResolvedValue({ id: 'patient-2', relationship: 'child' });
  mocks.getPatient.mockResolvedValue({ id: 'patient-1', relationship: 'self' });
  mocks.createIntake.mockResolvedValue({ id: 'response-1', revision: 1 });
  mocks.getLatestIntake.mockResolvedValue({ id: 'response-1', revision: 1 });
  mocks.archivePatient.mockResolvedValue(undefined);
  mocks.updatePatient.mockResolvedValue(undefined);
  mocks.history.mockResolvedValue({ patient: { id: 'patient-1' }, intakes: [], prescriptions: [], quotes: [], continuity: [], timeline: [] });
  mocks.access.mockResolvedValue(true);
  mocks.capability.mockResolvedValue(true);
});

describe('LIFF pharmacy patient and intake routes', () => {
  const request = (path: string, method = 'GET', body?: unknown) => pharmacyIntakeRoutes.request(
    `${path}${path.includes('?') ? '&' : '?'}liffId=liff-1`,
    {
      method,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

  it('lists only the verified LINE owner patients', async () => {
    const response = await request('/api/liff/pharmacy/patients');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ patients: [
      { id: 'patient-1', relationship: 'self' },
    ] });
    expect(mocks.listPatients).toHaveBeenCalledWith(env.DB, owner, false);
  });

  it('creates a family patient after validating the JSON boundary', async () => {
    const response = await request('/api/liff/pharmacy/patients', 'POST', {
      relationship: 'child', name: '子', nameKana: 'コ', birthDate: '2018-04-01',
      sex: null, contactPhone: null, postalCode: null, prefecture: null, city: null,
      addressLine1: null, addressLine2: null,
    });
    expect(response.status).toBe(201);
    expect(mocks.createPatient).toHaveBeenCalledWith(env.DB, owner, {
      relationship: 'child', name: '子', nameKana: 'コ', birthDate: '2018-04-01',
      sex: null, contactPhone: null, postalCode: null, prefecture: null, city: null,
      addressLine1: null, addressLine2: null,
    });
  });

  it('creates an intake revision only when both consents are supplied', async () => {
    const body = {
      idempotencyKey: 'intake-123',
      answers: {
        allergiesStatus: 'none', adverseReactionStatus: 'none', medicationStatus: 'none',
        medicalHistoryStatus: 'none', medicalHistoryTags: [], medicationNotebook: 'unknown',
        smokingStatus: 'never', alcoholStatus: 'none', medicationAdherence: 'none',
      },
      representativeConsent: true, privacyConsent: true,
    };
    const response = await request('/api/liff/pharmacy/patients/patient-1/intake', 'POST', body);
    expect(response.status).toBe(201);
    expect(mocks.createIntake).toHaveBeenCalledWith(
      env.DB, owner, 'patient-1', body,
    );
  });

  it('updates a patient profile with an expected version', async () => {
    const body = {
      expectedUpdatedAt: '2026-08-17T00:00:00.000Z', relationship: 'child', name: '子',
      nameKana: 'コ', birthDate: '2018-04-01', sex: null, contactPhone: null,
      postalCode: null, prefecture: null, city: null, addressLine1: null, addressLine2: null,
    };
    const response = await request('/api/liff/pharmacy/patients/patient-1', 'PATCH', body);
    expect(response.status).toBe(200);
    expect(mocks.updatePatient).toHaveBeenCalledWith(
      env.DB, owner, 'patient-1', body.expectedUpdatedAt, expect.objectContaining({ relationship: 'child' }),
    );
  });

  it('rejects an unverified LINE caller before reading patient data', async () => {
    mocks.verify.mockResolvedValue(null);
    const response = await request('/api/liff/pharmacy/patients');
    expect(response.status).toBe(401);
    expect(mocks.listPatients).not.toHaveBeenCalled();
  });
});

describe('admin pharmacy patient routes', () => {
  it('requires an account scope and returns the staff-visible patient list', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/patients?line_account_id=account-1', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.listAdminPatients).toHaveBeenCalledWith(
      env.DB, 'account-1', true,
    );
  });

  it('rejects a missing account scope', async () => {
    const response = await adminApp().request('/api/custom/pharmacy/patients', {}, env);
    expect(response.status).toBe(400);
    expect(mocks.listPatients).not.toHaveBeenCalled();
  });

  it('returns account-scoped patient history only after server-side account authorization', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/patients/patient-1/history?line_account_id=account-1', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.history).toHaveBeenCalledWith(env.DB, 'account-1', 'patient-1');
  });

  it('denies a staff member attempting another account history', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await adminApp().request(
      '/api/custom/pharmacy/patients/patient-1/history?line_account_id=account-2', {}, env,
    );
    expect(response.status).toBe(403);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it('returns the curated latest intake without storage-only fields', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/patients/patient-1/intake?line_account_id=account-1', {}, env,
    );
    const payload = await response.json() as { intake: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.intake).toMatchObject({ answers: { allergiesStatus: 'none' } });
    expect(payload.intake).not.toHaveProperty('patient_snapshot_json');
    expect(payload.intake).not.toHaveProperty('idempotency_key');
    expect(mocks.getLatestAdminIntake).toHaveBeenCalledWith(env.DB, 'account-1', 'patient-1');
  });

  it('fails closed when the patient-intake capability is disabled', async () => {
    mocks.capability.mockResolvedValue(false);
    const response = await adminApp().request(
      '/api/custom/pharmacy/patients?line_account_id=account-1', {}, env,
    );
    expect(response.status).toBe(403);
    expect(mocks.listAdminPatients).not.toHaveBeenCalled();
  });
});
