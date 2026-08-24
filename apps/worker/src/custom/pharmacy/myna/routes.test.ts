import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  launch: vi.fn(),
  report: vi.fn(),
  activePatient: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  verify: vi.fn(),
  active: vi.fn(),
  admin: vi.fn(),
  saveEndpoint: vi.fn(),
  setEndpointEnabled: vi.fn(),
  markEndpointVerified: vi.fn(),
  verifyIdentity: vi.fn(),
  resolvePatient: vi.fn(),
  enqueueActivity: vi.fn(),
  access: vi.fn(),
  capability: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createMynaHandoff: mocks.create,
  markMynaLaunchRequested: mocks.launch,
  recordMynaPatientReport: mocks.report,
  getActivePatientMynaHandoff: mocks.activePatient,
  listMynaHandoffs: mocks.list,
  getAdminMynaHandoff: mocks.detail,
  recordMynaVerification: mocks.verify,
}));
vi.mock('./endpoint-repository.js', () => ({
  getActiveMynaEndpoint: mocks.active,
  getAdminMynaEndpoint: mocks.admin,
  saveMynaEndpoint: mocks.saveEndpoint,
  setMynaEndpointEnabled: mocks.setEndpointEnabled,
  markMynaEndpointVerified: mocks.markEndpointVerified,
}));
vi.mock('../../../services/liff-auth.js', () => ({
  verifyCallerLineIdentity: mocks.verifyIdentity,
}));
vi.mock('../prescriptions/patient.js', () => ({
  resolvePrescriptionPatient: mocks.resolvePatient,
}));
vi.mock('../activity-notifications/repository.js', () => ({
  enqueueActivityForAccount: mocks.enqueueActivity,
}));
vi.mock('../operations-access.js', () => ({
  canAccessPharmacyOperationsAccount: mocks.access,
}));
vi.mock('../growth-loop/access.js', () => ({ hasPharmacyCapability: mocks.capability }));

import { mynaRoutes } from './routes.js';

const env = {
  DB: {} as D1Database,
  MYNA_ENDPOINT_ENCRYPTION_KEY: 'test-secret',
  MYNA_ALLOWED_HOSTS: 'myna.example.test',
  WORKER_PUBLIC_URL: 'https://pharmacy.example.test',
  LINE_CHANNEL_ID: 'channel-a',
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
  mocks.active.mockResolvedValue({
    line_account_id: 'account-1', tenant_alias: 'pharmacy-a',
    endpoint_url: 'https://myna.example.test/pharmacy/a',
  });
  mocks.create.mockResolvedValue({ handoff, expectation: { id: 'expectation-1', receipt_status: 'EXPECTED' } });
  mocks.launch.mockResolvedValue({ ...handoff, status: 'LAUNCH_REQUESTED' });
  mocks.report.mockResolvedValue({ ...handoff, status: 'PATIENT_REPORTED_COMPLETE' });
  mocks.activePatient.mockResolvedValue({ ...handoff, status: 'LAUNCH_REQUESTED' });
  mocks.verify.mockResolvedValue({
    verification: { id: 'verification-1', status: 'E_PRESCRIPTION_RECEIVED' },
    receiptStatus: 'RECEIVED', shadowSubmissionId: 'submission-1',
    handoff: { ...handoff, status: 'CLOSED' },
  });
  mocks.enqueueActivity.mockResolvedValue(null);
  mocks.access.mockResolvedValue(true);
  mocks.capability.mockResolvedValue(true);
  mocks.setEndpointEnabled.mockResolvedValue({
    id: 'endpoint-1', line_account_id: 'account-1', tenant_alias: 'pharmacy-a',
    endpoint_url_masked: 'https://myna.example.test/…', enabled: false,
    last_verified_at: null, revision: 1,
  });
  mocks.markEndpointVerified.mockResolvedValue(undefined);
});

describe('Myna routes', () => {
  it('changes endpoint enabled state without receiving the plaintext URL again', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/myna-endpoint?line_account_id=account-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, expectedRevision: 1 }),
      }, env,
    );

    expect(response.status).toBe(200);
    expect(mocks.setEndpointEnabled).toHaveBeenCalledWith(
      env.DB, 'account-1', false, 1, 'staff-1', 'test-secret',
    );
  });

  it('records a manual official-console verification for the assigned account', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/myna-endpoint/verification?line_account_id=account-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1 }),
      }, env,
    );

    expect(response.status).toBe(200);
    expect(mocks.markEndpointVerified).toHaveBeenCalledWith(env.DB, 'account-1', 1);
  });

  it('requires an endpoint revision and maps stale writes to conflict', async () => {
    const invalid = await app().request(
      '/api/custom/pharmacy/myna-endpoint?line_account_id=account-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }, env,
    );
    expect(invalid.status).toBe(400);
    expect(mocks.setEndpointEnabled).not.toHaveBeenCalled();

    mocks.markEndpointVerified.mockRejectedValueOnce(new Error('stale Myna endpoint revision'));
    const stale = await app().request(
      '/api/custom/pharmacy/myna-endpoint/verification?line_account_id=account-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1 }),
      }, env,
    );
    expect(stale.status).toBe(409);
  });

  it('rejects an admin handoff read outside the assigned account', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await app().request(
      '/api/custom/pharmacy/myna-handoffs?line_account_id=account-b', {}, env,
    );
    expect(response.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown handoff status filter before repository access', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/myna-handoffs?line_account_id=account-1&status=UNKNOWN', {}, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('creates a handoff for the authenticated LINE contact', async () => {
    const response = await app().request('/api/liff/pharmacy/myna-handoffs?liffId=123-abc', {
      method: 'POST',
      headers: { Authorization: 'Bearer line-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'E_PRESCRIPTION', correlationId: 'corr-1234' }),
    }, env);
    expect(response.status).toBe(201);
    const body = await response.json() as { launchUrl: string };
    expect(body.launchUrl).toMatch(/^https:\/\/pharmacy\.example\.test\/r\/myna\/[^/?]+\?openExternalBrowser=1$/);
    expect(body.launchUrl).not.toContain('patient');
    expect(body.launchUrl).not.toContain('pharmacy-a');
    expect(body.launchUrl).not.toContain('account-1');
    expect(mocks.active).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'account-1', friendId: 'friend-1', method: 'E_PRESCRIPTION', source: 'LIFF',
    }));
    expect(mocks.capability).toHaveBeenCalledWith(env.DB, 'account-1', 'electronic_prescription');
  });

  it('blocks only new electronic admission when its capability is off', async () => {
    mocks.capability.mockResolvedValue(false);
    const blocked = await app().request('/api/liff/pharmacy/myna-handoffs?liffId=123-abc', {
      method: 'POST',
      headers: { Authorization: 'Bearer line-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'E_PRESCRIPTION', correlationId: 'corr-1234' }),
    }, env);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(mocks.create).not.toHaveBeenCalled();

    const active = await app().request(
      '/api/liff/pharmacy/myna-handoffs/active?liffId=123-abc',
      { headers: { Authorization: 'Bearer line-token' } },
      env,
    );
    expect(active.status).toBe(200);
    expect(mocks.activePatient).toHaveBeenCalled();
  });

  it('restores only the authenticated LINE contact active handoff', async () => {
    const response = await app().request(
      '/api/liff/pharmacy/myna-handoffs/active?liffId=123-abc',
      { headers: { Authorization: 'Bearer line-token' } },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      handoff: { id: 'handoff-1', status: 'LAUNCH_REQUESTED' },
    });
    expect(mocks.activePatient).toHaveBeenCalledWith(env.DB, 'account-1', 'friend-1');
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

  async function issuedLaunchPath(): Promise<string> {
    const response = await app().request('/api/liff/pharmacy/myna-handoffs?liffId=123-abc', {
      method: 'POST',
      headers: { Authorization: 'Bearer line-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'E_PRESCRIPTION', correlationId: 'corr-1234' }),
    }, env);
    const body = await response.json() as { launchUrl: string };
    return new URL(body.launchUrl).pathname + new URL(body.launchUrl).search;
  }

  it('redirects only through the configured external endpoint with privacy headers, with no alias in the URL', async () => {
    const path = await issuedLaunchPath();
    expect(path).not.toContain('pharmacy-a');
    const response = await app().request(`${path}&patientId=secret`, {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://myna.example.test/pharmacy/a');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns an identical generic 404 for an unknown token', async () => {
    const response = await app().request('/r/myna/not-a-real-token', {}, env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Myna受付を利用できません');
  });

  it('returns the same generic 404 for a tampered signature', async () => {
    const path = await issuedLaunchPath();
    const [pathname] = path.split('?');
    const token = pathname.split('/r/myna/')[1];
    const [payloadPart, sigPart] = token.split('.');
    const tamperedSig = (sigPart[0] === 'A' ? 'B' : 'A') + sigPart.slice(1);
    const response = await app().request(`/r/myna/${payloadPart}.${tamperedSig}`, {}, env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Myna受付を利用できません');
  });

  it('returns the same generic 404 for an expired token', async () => {
    const path = await issuedLaunchPath();
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(31 * 60_000); // past the 30 min token TTL
      const response = await app().request(path, {}, env);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Myna受付を利用できません');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 404 (not the endpoint) for a valid token whose account endpoint is disabled', async () => {
    const path = await issuedLaunchPath();
    mocks.active.mockResolvedValueOnce(null); // simulates a disabled/retired endpoint for this account
    const response = await app().request(path, {}, env);
    expect(response.status).toBe(404);
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
