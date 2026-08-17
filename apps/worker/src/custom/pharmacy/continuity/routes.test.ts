import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolve: vi.fn(),
  adminList: vi.fn(),
  patientList: vi.fn(),
  pause: vi.fn(),
  listExpectations: vi.fn(),
  offerExpectation: vi.fn(),
  respondExpectation: vi.fn(),
}));

vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('./repository.js', () => ({
  listContinuityObligations: mocks.adminList,
  listPatientContinuity: mocks.patientList,
  pausePatientContinuity: mocks.pause,
}));
vi.mock('./next-intake.js', () => ({
  listNextIntakeExpectations: mocks.listExpectations,
  offerNextIntakeExpectation: mocks.offerExpectation,
  respondToNextIntakeExpectation: mocks.respondExpectation,
}));

import { continuityRoutes } from './routes.js';

const env = { DB: {} as D1Database };

function adminApp() {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: { id: string; name: string; role: 'admin' } };
  }>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' });
    await next();
  });
  app.route('/', continuityRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ lineUserId: 'U1', loginChannelId: 'login-1' });
  mocks.resolve.mockResolvedValue({ lineAccountId: 'account-1', friendId: 'friend-1' });
  mocks.adminList.mockResolvedValue([{ id: 'obligation-1', status: 'active' }]);
  mocks.patientList.mockResolvedValue([{ id: 'obligation-1', status: 'linked' }]);
  mocks.pause.mockResolvedValue(undefined);
  mocks.listExpectations.mockResolvedValue([{ id: 'expectation-1', status: 'offered' }]);
  mocks.offerExpectation.mockResolvedValue({ id: 'expectation-1', status: 'offered' });
  mocks.respondExpectation.mockResolvedValue({ id: 'expectation-1', status: 'accepted' });
});

describe('continuity routes', () => {
  it('lists staff obligations only with an account scope', async () => {
    const response = await adminApp().request('/api/custom/pharmacy/continuity?line_account_id=account-1', {}, env);
    expect(response.status).toBe(200);
    expect(mocks.adminList).toHaveBeenCalledWith(env.DB, 'account-1');
    expect(mocks.listExpectations).toHaveBeenCalledWith(env.DB, 'account-1');
  });

  it('returns the verified patient continuity view', async () => {
    const response = await continuityRoutes.request('/api/liff/pharmacy/continuity?liffId=liff-1', {
      headers: { Authorization: 'Bearer token' },
    }, env);
    expect(response.status).toBe(200);
    expect(mocks.patientList).toHaveBeenCalledWith(env.DB, 'account-1', 'friend-1');
    expect(mocks.listExpectations).toHaveBeenCalledWith(env.DB, 'account-1', 'friend-1');
  });

  it('fails closed when the LINE identity cannot be resolved', async () => {
    mocks.resolve.mockResolvedValue(null);
    const response = await continuityRoutes.request('/api/liff/pharmacy/continuity?liffId=liff-1', {
      headers: { Authorization: 'Bearer token' },
    }, env);
    expect(response.status).toBe(404);
  });

  it('allows the verified patient to pause future follow-up reminders', async () => {
    const response = await continuityRoutes.request('/api/liff/pharmacy/continuity/obligation-1/pause?liffId=liff-1', {
      method: 'POST', headers: { Authorization: 'Bearer token' },
    }, env);
    expect(response.status).toBe(200);
    expect(mocks.pause).toHaveBeenCalledWith(env.DB, 'account-1', 'friend-1', 'obligation-1');
  });

  it('lets staff offer only bounded manual timing inside the guarded account', async () => {
    const response = await adminApp().request(
      '/api/custom/pharmacy/continuity/obligation-1/expectations?line_account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timingSource: 'manual_supply_days', supplyDays: 28,
          idempotencyKey: 'offer-request-1', patientId: 'patient-from-browser',
        }),
      },
      env,
    );
    expect(response.status).toBe(201);
    expect(mocks.offerExpectation).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-1', obligationId: 'obligation-1',
      timing: { source: 'manual_supply_days', supplyDays: 28 },
      staffId: 'staff-1', idempotencyKey: 'offer-request-1',
    });
  });

  it('records next-intake consent only for the verified LINE friend', async () => {
    const response = await continuityRoutes.request(
      '/api/liff/pharmacy/continuity/expectations/expectation-1/respond?liffId=liff-1',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'accepted', idempotencyKey: 'patient-request-1' }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(mocks.respondExpectation).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-1', friendId: 'friend-1', expectationId: 'expectation-1',
      response: 'accepted', idempotencyKey: 'patient-request-1',
    });
  });
});
