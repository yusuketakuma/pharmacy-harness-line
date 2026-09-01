import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), resolve: vi.fn(), list: vi.fn() }));
vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('./repository.js', () => ({ listPatientTimeline: mocks.list }));

import { patientTimelineRoutes } from './routes.js';

const env = { DB: {} as D1Database };
const patient = { lineAccountId: 'account-a', friendId: 'friend-a' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({
    lineUserId: 'U-a', loginChannelId: 'login-a', tenantId: 'tenant-a', lineAccountId: 'account-a',
  });
  mocks.resolve.mockResolvedValue(patient);
  mocks.list.mockResolvedValue([{
    domain: 'prescription', status: 'pending', nextAction: 'wait',
    occurredAt: '2026-09-01T00:00:00.000Z', detailPath: '/prescriptions?view=history',
  }]);
});

describe('patient timeline route', () => {
  it('uses verified identity scope and returns a non-cacheable narrow projection', async () => {
    const response = await patientTimelineRoutes.request(
      '/api/liff/pharmacy/timeline?liffId=liff-a&line_account_id=account-b&friendId=friend-b',
      { headers: { Authorization: 'Bearer token' } },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.resolve).toHaveBeenCalledWith(env.DB, 'liff-a', expect.objectContaining({
      lineAccountId: 'account-a',
    }));
    expect(mocks.list).toHaveBeenCalledWith(env.DB, patient);
    await expect(response.json()).resolves.toEqual({ items: [{
      domain: 'prescription', status: 'pending', nextAction: 'wait',
      occurredAt: '2026-09-01T00:00:00.000Z', detailPath: '/prescriptions?view=history',
    }] });
  });

  it('fails closed before querying on missing or unbound identity', async () => {
    mocks.verify.mockResolvedValueOnce(null);
    const unauthorized = await patientTimelineRoutes.request(
      '/api/liff/pharmacy/timeline?liffId=liff-a', {}, env,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.list).not.toHaveBeenCalled();

    mocks.resolve.mockResolvedValueOnce(null);
    const missing = await patientTimelineRoutes.request(
      '/api/liff/pharmacy/timeline?liffId=liff-a',
      { headers: { Authorization: 'Bearer token' } },
      env,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
