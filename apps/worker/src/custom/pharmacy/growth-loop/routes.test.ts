import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  capability: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  dashboard: vi.fn(),
  source: vi.fn(),
  classify: vi.fn(),
  validity: vi.fn(),
  setSourceActive: vi.fn(),
  readiness: vi.fn(),
  configurationDoctor: vi.fn(),
  operationsSummary: vi.fn(),
}));

vi.mock('./access.js', () => ({
  PATIENT_PHARMACY_CAPABILITIES: [
    'prescription_intake', 'patient_intake', 'electronic_prescription',
    'continuity', 'medication_followup', 'emergency_contraception',
    'manual_chat', 'pharmacy_info',
  ],
  resolveAccessiblePharmacyTenant: mocks.access,
  hasPharmacyCapability: mocks.capability,
}));
vi.mock('./repository.js', () => ({
  getPharmacyCapabilityConfig: mocks.getConfig,
  savePharmacyCapabilityConfig: mocks.saveConfig,
  getGrowthDashboard: mocks.dashboard,
  createMedicalSource: mocks.source,
  classifySubmissionSource: mocks.classify,
  savePrescriptionValidity: mocks.validity,
  setMedicalSourceActive: mocks.setSourceActive,
}));
vi.mock('../readiness.js', () => ({ getPharmacyReadiness: mocks.readiness }));
vi.mock('../configuration-doctor.js', () => ({
  getPharmacyConfigurationDoctor: mocks.configurationDoctor,
}));
vi.mock('./operations-summary.js', () => ({ getPharmacyOperationsSummary: mocks.operationsSummary }));

import { pharmacyGrowthLoopRoutes } from './routes.js';

const env = {
  DB: {} as D1Database,
  LIFF_PUBLIC_URL: 'https://liff.example.test',
  LINE_CREDENTIAL_KEY_V1: 'credential-root-key',
};

type TestStaff = { id: string; name: string; role: 'owner' | 'admin' | 'staff' };

function app(staff: TestStaff = { id: 'staff-1', name: 'Staff', role: 'admin' }) {
  const root = new Hono<{
    Bindings: typeof env;
    Variables: { staff: typeof staff; tenantId: string };
  }>();
  root.use('*', async (c, next) => {
    c.set('staff', staff);
    c.set('tenantId', 'tenant-a');
    await next();
  });
  root.route('/', pharmacyGrowthLoopRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue('tenant-a');
  mocks.capability.mockResolvedValue(true);
  mocks.getConfig.mockResolvedValue({ line_account_id: 'account-a', mode: 'pharmacy', capabilities: ['pharmacy_dashboard'], revision: 7 });
  mocks.saveConfig.mockResolvedValue({ line_account_id: 'account-a', mode: 'pharmacy', capabilities: ['pharmacy_dashboard'], revision: 8 });
  mocks.dashboard.mockResolvedValue({ from: '2026-08-01', to: '2026-09-01', entry: {}, sources: {}, promises: {}, validity: {}, notifications: {} });
  mocks.source.mockResolvedValue({ id: 'source-1', display_name: 'Clinic A', classification: 'primary' });
  mocks.readiness.mockResolvedValue({ accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z' });
  mocks.configurationDoctor.mockResolvedValue({
    accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
    status: 'READY', reasonCodes: [], checks: [],
  });
  mocks.operationsSummary.mockResolvedValue({ accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z' });
});

describe('pharmacy Growth Loop routes', () => {
  it('returns readiness with the same account-scoped configuration doctor after authorization', async () => {
    const response = await app().request('/api/custom/pharmacy/readiness?line_account_id=account-a', {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { accountId: 'account-a', configurationDoctor: { accountId: 'account-a', status: 'READY' } },
    });
    expect(mocks.readiness).toHaveBeenCalledWith(env.DB, 'account-a');
    expect(mocks.configurationDoctor).toHaveBeenCalledWith({
      db: env.DB,
      tenantId: 'tenant-a',
      accountId: 'account-a',
      liffPublicUrl: env.LIFF_PUBLIC_URL,
      credentialKey: env.LINE_CREDENTIAL_KEY_V1,
      readiness: expect.objectContaining({ accountId: 'account-a' }),
    });
  });

  it('returns an account-scoped non-PHI operations summary after authorization', async () => {
    const response = await app().request('/api/custom/pharmacy/operations-summary?line_account_id=account-a', {}, env);
    expect(response.status).toBe(200);
    expect(mocks.operationsSummary).toHaveBeenCalledWith(env.DB, 'account-a');

    mocks.access.mockResolvedValue(null);
    const denied = await app().request('/api/custom/pharmacy/operations-summary?line_account_id=account-b', {}, env);
    expect(denied.status).toBe(403);
    expect(mocks.operationsSummary).not.toHaveBeenCalledWith(env.DB, 'account-b');
  });

  it('rejects account-less requests before repository access', async () => {
    const response = await app().request('/api/custom/pharmacy/growth/dashboard', {}, env);
    expect(response.status).toBe(400);
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it('denies a staff member who cannot access the selected account', async () => {
    mocks.access.mockResolvedValue(null);
    const response = await app().request('/api/custom/pharmacy/growth/dashboard?line_account_id=account-b', {}, env);
    expect(response.status).toBe(403);
    expect(mocks.capability).not.toHaveBeenCalled();
  });

  it('does not treat account query parameters as capability authority', async () => {
    mocks.capability.mockResolvedValue(false);
    const response = await app().request('/api/custom/pharmacy/growth/dashboard?line_account_id=account-a', {}, env);
    expect(response.status).toBe(403);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it('rejects malformed dashboard date ranges before querying metrics', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/growth/dashboard?line_account_id=account-a&from=not-a-date&to=2026-09-01',
      {}, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it('rejects impossible calendar dates before querying metrics', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/growth/dashboard?line_account_id=account-a&from=2026-02-31T00%3A00%3A00.000Z&to=2026-03-04T00%3A00%3A00.000Z',
      {}, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it('canonicalizes valid offset bounds before querying metrics', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/growth/dashboard?line_account_id=account-a&from=2026-08-01T00%3A00%3A00%2B09%3A00&to=2026-09-01T00%3A00%3A00%2B09%3A00',
      {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.dashboard).toHaveBeenCalledWith(
      env.DB,
      'account-a',
      '2026-07-31T15:00:00.000Z',
      '2026-08-31T15:00:00.000Z',
    );
  });

  it('rejects dashboard ranges longer than 32 days', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/growth/dashboard?line_account_id=account-a&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-03T00%3A00%3A00.001Z',
      {}, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it('allows only an owner to change the pharmacy allowlist', async () => {
    const response = await app().request('/api/custom/pharmacy/growth/config?line_account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: ['prescription_intake'], expectedRevision: 7 }),
    }, env);
    expect(response.status).toBe(403);

    const owner = app({ id: 'owner-1', name: 'Owner', role: 'owner' });
    const allowed = await owner.request('/api/custom/pharmacy/growth/config?line_account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: [], expectedRevision: 7 }),
    }, env);
    expect(allowed.status).toBe(200);
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      env.DB, 'account-a', [], 1, 'alert_only', 'owner-1', 7,
    );
    const source = readFileSync(new URL('./routes.ts', import.meta.url).pathname, 'utf8');
    const configRoute = source.slice(
      source.indexOf("pharmacyGrowthLoopRoutes.put('/api/custom/pharmacy/growth/config'"),
      source.indexOf("pharmacyGrowthLoopRoutes.get('/api/custom/pharmacy/growth/dashboard'"),
    );
    expect(configRoute).not.toMatch(/fetch\(|richMenu|LINE/);
  });

  it('rejects management and unknown capabilities on the patient feature endpoint', async () => {
    const owner = app({ id: 'owner-1', name: 'Owner', role: 'owner' });
    for (const capability of ['pharmacy_dashboard', 'future_unknown']) {
      const response = await owner.request(
        '/api/custom/pharmacy/growth/config?line_account_id=account-a',
        {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capabilities: [capability], expectedRevision: 7 }),
        },
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('keeps unfollow monitoring alert-only until auto-pause has safety thresholds', async () => {
    const response = await app({ id: 'owner-1', name: 'Owner', role: 'owner' }).request(
      '/api/custom/pharmacy/growth/config?line_account_id=account-a',
      {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['pharmacy_dashboard'], unfollowAlertState: 'auto_pause' }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('writes an account-scoped manual medical source', async () => {
    const response = await app().request('/api/custom/pharmacy/growth/sources?line_account_id=account-a', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Clinic A', classification: 'primary' }),
    }, env);
    expect(response.status).toBe(201);
    expect(mocks.source).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', displayName: 'Clinic A', classification: 'primary', staffId: 'staff-1',
    });
  });

  it('updates a medical source only through the account-scoped settings capability', async () => {
    const response = await app().request('/api/custom/pharmacy/growth/sources/source-1?line_account_id=account-a', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    }, env);

    expect(response.status).toBe(200);
    expect(mocks.setSourceActive).toHaveBeenCalledWith(
      env.DB, 'account-a', 'source-1', false, 'staff-1',
    );
  });
});
