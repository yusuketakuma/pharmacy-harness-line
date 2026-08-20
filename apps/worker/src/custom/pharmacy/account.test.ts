import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const access = vi.hoisted(() => vi.fn());

vi.mock('./growth-loop/access.js', () => ({
  resolveAccessiblePharmacyTenant: access,
}));

import type { Env } from '../../index.js';
import { pharmacyAccountGuard } from './account.js';

const env = { DB: {} as D1Database } as Env['Bindings'];

function app(staff: Env['Variables']['staff'] | null = {
  id: 'staff-a', name: 'Staff A', role: 'admin',
}, tenantId = 'tenant-a') {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    if (staff) {
      c.set('staff', staff);
      c.set('tenantId', tenantId);
    }
    await next();
  });
  root.use('/api/custom/pharmacy/*', pharmacyAccountGuard);
  root.get('/api/custom/pharmacy/example', (c) => c.json({
    accountId: c.get('pharmacyLineAccountId'),
    tenantId: c.get('pharmacyTenantId'),
  }));
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue('tenant-a');
});

describe('pharmacy account guard', () => {
  it('rejects an account query parameter when staff is not assigned to it', async () => {
    access.mockResolvedValue(null);
    const response = await app().request(
      '/api/custom/pharmacy/example?line_account_id=account-b', {}, env,
    );

    expect(response.status).toBe(403);
    expect(access).toHaveBeenCalledWith(env.DB, expect.objectContaining({ id: 'staff-a' }), 'account-b');
  });

  it('accepts the legacy rich-menu accountId spelling only after authorization', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/example?accountId=account-a', {}, env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: 'account-a',
      tenantId: 'tenant-a',
    });
  });

  it('rejects an authorized account that belongs to a different login tenant', async () => {
    access.mockResolvedValue('tenant-b');
    const response = await app().request(
      '/api/custom/pharmacy/example?line_account_id=account-b', {}, env,
    );

    expect(response.status).toBe(403);
  });

  it('fails closed when account or authenticated staff is missing', async () => {
    expect((await app().request('/api/custom/pharmacy/example', {}, env)).status).toBe(400);
    expect((await app(null).request(
      '/api/custom/pharmacy/example?line_account_id=account-a', {}, env,
    )).status).toBe(401);
    expect(access).not.toHaveBeenCalled();
  });
});
