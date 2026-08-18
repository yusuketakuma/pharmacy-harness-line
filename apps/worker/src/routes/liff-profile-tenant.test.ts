import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const mocks = vi.hoisted(() => ({
  verifyIdentity: vi.fn(),
  verifyUserId: vi.fn(),
  getScopedFriend: vi.fn(),
  getGlobalFriend: vi.fn(),
}));

vi.mock('../services/liff-auth.js', () => ({
  verifyCallerLineIdentity: mocks.verifyIdentity,
  verifyCallerLineUserId: mocks.verifyUserId,
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@line-crm/db')>()),
  getFriendByLineUserIdForAccount: mocks.getScopedFriend,
  getFriendByLineUserId: mocks.getGlobalFriend,
}));

const { liffRoutes } = await import('./liff.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdentity.mockResolvedValue({
    lineUserId: 'U-shared',
    loginChannelId: 'login-a',
    lineAccountId: 'account-a',
    tenantId: 'tenant-a',
  });
  mocks.verifyUserId.mockResolvedValue('U-shared');
  mocks.getGlobalFriend.mockResolvedValue({
    id: 'friend-b',
    display_name: 'Tenant B patient',
    is_following: 1,
    user_id: 'patient-b',
  });
  mocks.getScopedFriend.mockResolvedValue({
    id: 'friend-a',
    display_name: 'Tenant A patient',
    is_following: 1,
    user_id: 'patient-a',
  });
});

describe('POST /api/liff/profile tenant boundary', () => {
  it('binds the verified LINE audience to the matching account-scoped friend', async () => {
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request('/api/liff/profile', {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-token' },
    }, { DB: {} as D1Database } as Env['Bindings']);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: 'friend-a', displayName: 'Tenant A patient', userId: 'patient-a' },
    });
    expect(mocks.getScopedFriend).toHaveBeenCalledWith(
      expect.anything(),
      'U-shared',
      'account-a',
    );
    expect(mocks.getGlobalFriend).not.toHaveBeenCalled();
  });

  it('does not fall back to a shared environment account for an unknown LIFF ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ basicId: '@wrong-tenant' }), { status: 200 }),
    );
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request('/api/liff/config?liffId=unknown', {}, {
      DB: db,
      LINE_CHANNEL_ACCESS_TOKEN: 'shared-default-token',
    } as Env['Bindings']);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
