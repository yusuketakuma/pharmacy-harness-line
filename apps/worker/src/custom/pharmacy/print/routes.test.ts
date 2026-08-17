import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({ access: vi.fn(), prepare: vi.fn(), claim: vi.fn(), acknowledge: vi.fn() }));
vi.mock('../operations-access.js', () => ({ canAccessPharmacyOperationsAccount: mocks.access }));
vi.mock('./repository.js', () => ({
  preparePrescriptionPrintTask: mocks.prepare,
  claimPrescriptionPrintTask: mocks.claim,
  acknowledgePrescriptionPrintTask: mocks.acknowledge,
}));

import { pharmacyPrintRoutes } from './routes.js';

const env = { DB: {} as D1Database, LINE_CHANNEL_ID: 'channel-a' };
function app(withStaff = true) {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    if (withStaff) c.set('staff', { id: 'staff-a', name: 'Staff', role: 'admin' });
    await next();
  });
  root.route('/', pharmacyPrintRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.prepare.mockResolvedValue({ id: 'task-1', status: 'pending', revision: 1 });
  mocks.claim.mockResolvedValue({ id: 'task-1', status: 'handling', revision: 1 });
  mocks.acknowledge.mockResolvedValue({ id: 'task-1', status: 'acknowledged', revision: 1 });
});

describe('pharmacy web print routes', () => {
  it('rejects an authenticated staff member outside the requested account', async () => {
    mocks.access.mockResolvedValue(false);
    const response = await app().request(
      '/api/custom/pharmacy/print/submissions/submission-a/prepare?line_account_id=account-b',
      { method: 'POST' }, env,
    );
    expect(response.status).toBe(403);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('claims before printing and binds the browser operation id server-side', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/print/tasks/task-1/claim?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: 'session-a' }) },
      env,
    );
    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(env.DB, 'account-a', 'task-1', 'staff-a', 'session-a');
  });

  it('returns conflict when another browser owns the task', async () => {
    mocks.claim.mockResolvedValue(null);
    const response = await app().request(
      '/api/custom/pharmacy/print/tasks/task-1/claim?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: 'session-b' }) },
      env,
    );
    expect(response.status).toBe(409);
  });
});
