import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({ verify: vi.fn(), resolve: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('./repository.js', () => ({
  getPharmacyPublicProfile: mocks.get,
  savePharmacyPublicProfile: mocks.save,
}));

import { pharmacyPublicProfileRoutes } from './routes.js';

const env = { DB: {} as D1Database };
const profile = { line_account_id: 'account-a', display_name: 'みどり薬局' };

function app(role: 'owner' | 'admin' | 'staff' = 'admin') {
  const root = new Hono<never>();
  root.use('*', async (c, next) => {
    c.set('staff' as never, { id: 'staff-a', name: 'Staff', role } as never);
    c.set('pharmacyLineAccountId' as never, 'account-a' as never);
    await next();
  });
  root.route('/', pharmacyPublicProfileRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({ lineUserId: 'U-a' });
  mocks.resolve.mockResolvedValue({ lineAccountId: 'account-a', friendId: 'friend-a' });
  mocks.get.mockResolvedValue(profile);
  mocks.save.mockResolvedValue(undefined);
});

describe('pharmacy public profile routes', () => {
  it('ignores request account fields and saves under middleware scope', async () => {
    const res = await app().request('/api/custom/pharmacy/public-profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'みどり薬局', lineAccountId: 'account-b' }),
    }, env);
    expect(res.status).toBe(204);
    expect(mocks.save).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lineAccountId: 'account-a', staffId: 'staff-a', displayName: 'みどり薬局',
    }));
  });

  it('rejects a staff editor', async () => {
    const res = await app('staff').request('/api/custom/pharmacy/public-profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, env);
    expect(res.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('resolves the LIFF account from verified identity, not query authority', async () => {
    const res = await app().request('/api/liff/pharmacy/public-profile?liffId=liff-a&line_account_id=account-b', {}, env);
    expect(res.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(env.DB, 'account-a');
    await expect(res.json()).resolves.toEqual({ profile: { display_name: 'みどり薬局' } });
  });

  it('rejects an unauthenticated LIFF caller', async () => {
    mocks.verify.mockResolvedValue(null);
    expect((await app().request('/api/liff/pharmacy/public-profile', {}, env)).status).toBe(401);
  });
});
