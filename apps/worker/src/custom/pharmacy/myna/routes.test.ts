import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  launch: vi.fn(),
  report: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  verify: vi.fn(),
  active: vi.fn(),
  alias: vi.fn(),
  admin: vi.fn(),
  saveEndpoint: vi.fn(),
  verifyIdentity: vi.fn(),
  resolvePatient: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createMynaHandoff: mocks.create,
  markMynaLaunchRequested: mocks.launch,
  recordMynaPatientReport: mocks.report,
  listMynaHandoffs: mocks.list,
  getAdminMynaHandoff: mocks.detail,
  recordMynaVerification: mocks.verify,
}));
vi.mock('./endpoint-repository.js', () => ({
  getActiveMynaEndpoint: mocks.active,
  getMynaEndpointByAlias: mocks.alias,
  getAdminMynaEndpoint: mocks.admin,
  saveMynaEndpoint: mocks.saveEndpoint,
}));
vi.mock('../../../services/liff-auth.js', () => ({
  verifyCallerLineIdentity: mocks.verifyIdentity,
}));
vi.mock('../prescriptions/patient.js', () => ({
  resolvePrescriptionPatient: mocks.resolvePatient,
}));

import { mynaRoutes } from './routes.js';

const env = {
  DB: {} as D1Database,
  MYNA_ENDPOINT_ENCRYPTION_KEY: 'test-secret',
  MYNA_ALLOWED_HOSTS: 'myna.example.test',
  WORKER_PUBLIC_URL: 'https://pharmacy.example.test',
};

function app(withStaff = true) {
  const root = new Hono<{
    Bindings: typeof env;
    Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
  }>();
  if (withStaff) {
    root.use('*', async (c, next) => {
      c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
      await next();
    });
  }
  root.route('/', mynaRoutes);
  return root;
}

const patient = { lineAccountId: 'account-1', friendId: 'friend-1' };
const handoff = {
  id: 'handoff-1', line_account_id: 'account-1', friend_id: 'friend-1', patient_id: null,
  expectation_id: 'expectation-1', method: 'E_PRESCRIPTION', status: 'CREATED', source: 'LIFF',
  correlation_id: 'corr-1234', launched_at: null, patient_reported_at: null,
  expires_at: '2099-08-17T10:00:00.000Z', closed_at: null,
  created_at: '2026-08-17T09:00:00.000Z', updated_at: '2026-08-17T09:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdentity.mockResolvedValue({ userId: 'line-user-1' });
  mocks.resolvePatient.mockResolvedValue(patient);
  mocks.active.mockResolvedValue({ tenant_alias: 'pharmacy-a', endpoint_url: 'https://myna.example.test/pharmacy/a' });
  mocks.alias.mockResolvedValue({ endpoint_url: 'https://myna.example.test/pharmacy/a' });
  mocks.create.mockResolvedValue({ handoff, expectation: { id: 'expectation-1', receipt_status: 'EXPECTED' } });
  mocks.launch.mockResolvedValue({ ...handoff, status: 'LAUNCH_REQUESTED' });
  mocks.report.mockResolvedValue({ ...handoff, status: 'PATIENT_REPORTED_COMPLETE' });
  mocks.verify.mockResolvedValue({
    verification: { id: 'verification-1', status: 'E_PRESCRIPTION_RECEIVED' },
    receiptStatus: 'RECEIVED', shadowSubmissionId: 'submission-1',
    handoff: { ...handoff, status: 'CLOSED' },
  });
});

describe('Myna routes', () => {
  it('creates a handoff for the authenticated LINE contact', async () => {
    const response = await app().request('/api/liff/pharmacy/myna-handoffs?liffId=123-abc', {
      method: 'POST',
      headers: { Authorization: 'Bearer line-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'E_PRESCRIPTION', correlationId: 'corr-1234' }),
    }, env);
    expect(response.status).toBe(201);
    const body = await response.json() as { launchUrl: string };
    expect(body.launchUrl).toContain('/r/myna/pharmacy-a?openExternalBrowser=1');
    expect(body.launchUrl).not.toContain('patient');
    expect(mocks.active).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'account-1', friendId: 'friend-1', method: 'E_PRESCRIPTION', source: 'LIFF',
    }));
  });

  it('records patient completion without treating it as official receipt', async () => {
    const response = await app().request('/api/liff/pharmacy/myna-handoffs/handoff-1/patient-report?liffId=123-abc', {
      method: 'POST',
      headers: { Authorization: 'Bearer line-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'COMPLETED' }),
    }, env);
    expect(response.status).toBe(200);
    expect(mocks.report).toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('redirects only through the configured external endpoint with privacy headers', async () => {
    const response = await app().request('/r/myna/pharmacy-a?openExternalBrowser=1&patientId=secret', {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://myna.example.test/pharmacy/a');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('requires pharmacist-level role for sensitive verification outcomes', async () => {
    const root = new Hono<{ Bindings: typeof env; Variables: { staff: { id: string; name: string; role: 'staff' } } }>();
    root.use('*', async (c, next) => { c.set('staff', { id: 'staff-1', name: 'Staff', role: 'staff' }); await next(); });
    root.route('/', mynaRoutes);
    const response = await root.request('/api/custom/pharmacy/myna-handoffs/handoff-1/verifications?line_account_id=account-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'SUBMITTED_TO_OTHER_PHARMACY', sourceSystem: 'terminal' }),
    }, env);
    expect(response.status).toBe(403);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
