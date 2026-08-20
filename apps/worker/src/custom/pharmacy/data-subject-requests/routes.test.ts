import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  verify: vi.fn(),
  assess: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('./repository.js', () => ({
  createDataSubjectRequest: mocks.create,
  listDataSubjectRequests: mocks.list,
  markDataSubjectIdentityVerified: mocks.verify,
  assessDataSubjectLegalHold: mocks.assess,
  resolveDataSubjectRequest: mocks.resolve,
}));

import { dataSubjectRequestRoutes } from './routes.js';

const env = { DB: {} as D1Database };
const PATH = '/api/custom/pharmacy/data-subject-requests';

function app(role: 'owner' | 'admin' | 'staff' = 'admin', accountId: string | null = 'account-a') {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Staff A', role });
    c.set('tenantId', 'tenant-a');
    c.set('pharmacyTenantId', 'tenant-a');
    if (accountId) c.set('pharmacyLineAccountId', accountId);
    await next();
  });
  root.route('/', dataSubjectRequestRoutes);
  return root;
}

const post = (path: string, body: unknown, role?: 'owner' | 'admin' | 'staff') => app(role).request(
  path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: 'request-1', status: 'received', version: 1 });
  mocks.verify.mockResolvedValue({ id: 'request-1', status: 'identity_verified', version: 2 });
  mocks.assess.mockResolvedValue({
    id: 'request-1', status: 'legal_hold_assessed', version: 3, legal_hold: 1,
    legal_hold_release_at: '2027-08-20T00:00:00.000Z',
  });
  mocks.resolve.mockResolvedValue({ id: 'request-1', status: 'resolved', version: 4 });
});

describe('pharmacy data subject request routes', () => {
  it('refuses a request without a resolved pharmacy account scope', async () => {
    const response = await app('admin', null).request(PATH, {}, env);
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists only the requests of the resolved account', async () => {
    const response = await app().request(PATH, {}, env);
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(env.DB, 'account-a');
    await expect(response.json()).resolves.toEqual({ requests: [] });
  });

  it('refuses a non-admin staff member for every mutating step', async () => {
    const paths: Array<[string, unknown]> = [
      [PATH, { patientId: 'patient-a', requestType: 'erasure', reason: '申し出' }],
      [`${PATH}/request-1/identity-verification`, { expectedVersion: 1 }],
      [`${PATH}/request-1/legal-hold-assessment`, { expectedVersion: 2 }],
      [`${PATH}/request-1/resolution`, { expectedVersion: 3, decision: 'rejected', outcomeNote: '説明済み' }],
    ];
    for (const [path, body] of paths) {
      expect((await post(path, body, 'staff')).status).toBe(403);
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.assess).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('creates a request with the server-resolved tenant and account', async () => {
    const response = await post(PATH, {
      patientId: 'patient-a', requestType: 'erasure', reason: '本人から消去の申し出',
    });
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', tenantId: 'tenant-a', patientId: 'patient-a',
      requestType: 'erasure', reason: '本人から消去の申し出', staffId: 'staff-a',
    });
  });

  it('rejects an unknown request type and an empty reason before the repository', async () => {
    expect((await post(PATH, { patientId: 'p', requestType: 'delete_everything', reason: 'x' })).status).toBe(400);
    expect((await post(PATH, { patientId: 'p', requestType: 'erasure', reason: '   ' })).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('marks identity verification and the legal hold assessment', async () => {
    expect((await post(`${PATH}/request-1/identity-verification`, { expectedVersion: 1 })).status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', requestId: 'request-1', expectedVersion: 1, staffId: 'staff-a',
    });

    const assessed = await post(`${PATH}/request-1/legal-hold-assessment`, { expectedVersion: 2 });
    expect(assessed.status).toBe(200);
    await expect(assessed.json()).resolves.toMatchObject({
      request: { legal_hold: 1, legal_hold_release_at: '2027-08-20T00:00:00.000Z' },
    });
  });

  it('reports a legal hold refusal as a conflict the staff can explain', async () => {
    mocks.resolve.mockRejectedValue(new Error('legal hold blocks this data subject request'));
    const response = await post(`${PATH}/request-1/resolution`, {
      expectedVersion: 3, decision: 'resolved', outcomeNote: '消去した',
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ status: 'legal_hold' });
  });

  it('resolves a request with an outcome note', async () => {
    const response = await post(`${PATH}/request-1/resolution`, {
      expectedVersion: 3, decision: 'rejected', outcomeNote: '法定保存期間中のため応じられない旨を説明',
    });
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', requestId: 'request-1', expectedVersion: 3,
      decision: 'rejected', outcomeNote: '法定保存期間中のため応じられない旨を説明', staffId: 'staff-a',
    });
  });

  it('requires a decision and an outcome note to close a request', async () => {
    expect((await post(`${PATH}/request-1/resolution`, { expectedVersion: 3, decision: 'resolved' })).status).toBe(400);
    expect((await post(`${PATH}/request-1/resolution`, { expectedVersion: 3, decision: 'archived', outcomeNote: 'x' })).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('reports a stale version as a conflict, not a success', async () => {
    mocks.verify.mockRejectedValue(new Error('data subject request transition conflict'));
    expect((await post(`${PATH}/request-1/identity-verification`, { expectedVersion: 1 })).status).toBe(409);
  });

  it('reports an unknown request as not found', async () => {
    mocks.assess.mockRejectedValue(new Error('data subject request not found'));
    expect((await post(`${PATH}/request-1/legal-hold-assessment`, { expectedVersion: 2 })).status).toBe(404);
  });
});
