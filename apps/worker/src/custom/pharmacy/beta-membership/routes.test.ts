import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  resolveTenant: vi.fn(),
  list: vi.fn(),
  grant: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../growth-loop/access.js', () => ({
  resolveAccessiblePharmacyTenant: mocks.resolveTenant,
}));
vi.mock('./repository.js', () => ({
  listPharmacyBetaMemberships: mocks.list,
  grantPharmacyBetaMembership: mocks.grant,
  transitionPharmacyBetaMembership: mocks.transition,
}));

import { betaMembershipRoutes } from './routes.js';

const env = { DB: {} as D1Database };
const membership = {
  id: 'membership-1', line_account_id: 'account-a', participant_friend_id: 'friend-a',
  subject_patient_id: 'patient-a', access_kind: 'self', status: 'active',
  starts_at: '2026-09-14T00:00:00.000Z', expires_at: '2026-10-01T00:00:00.000Z',
  revoked_at: null, revoke_reason_code: null, version: 1,
  created_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z',
};

function app(role: 'owner' | 'admin' | 'staff' = 'admin') {
  const root = new Hono<{
    Bindings: { DB: D1Database };
    Variables: {
      staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
      tenantId: string;
    };
  }>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Staff A', role });
    c.set('tenantId', 'tenant-a');
    await next();
  });
  root.route('/', betaMembershipRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenant.mockResolvedValue('tenant-a');
  mocks.list.mockResolvedValue([membership]);
  mocks.grant.mockResolvedValue(membership);
  mocks.transition.mockResolvedValue({ ...membership, status: 'suspended', version: 2 });
});

describe('pharmacy beta membership routes', () => {
  it('lists memberships only after server-side tenant assignment checks', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/beta-memberships?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: { memberships: [membership] } });
    expect(mocks.resolveTenant).toHaveBeenCalledWith(env.DB, expect.objectContaining({ id: 'staff-a' }), 'account-a');
    expect(mocks.list).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('rejects a staff-role or cross-tenant request before reading memberships', async () => {
    expect((await app('staff').request(
      '/api/custom/pharmacy/beta-memberships?line_account_id=account-a', {}, env,
    )).status).toBe(403);
    mocks.resolveTenant.mockResolvedValue(null);
    expect((await app().request(
      '/api/custom/pharmacy/beta-memberships?line_account_id=account-b', {}, env,
    )).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('uses a canonical expiry and the resolved account for grants', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/beta-memberships?line_account_id=account-a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patientId: 'patient-a', expiresAt: '2026-10-01T00:00:00.000Z', lineAccountId: 'account-b' }),
      }, env,
    );
    expect(response.status).toBe(201);
    expect(mocks.grant).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', patientId: 'patient-a',
      expiresAt: '2026-10-01T00:00:00.000Z', actorStaffId: 'staff-a',
    });
  });

  it('maps adult-family verification and stale transitions without exposing details', async () => {
    mocks.grant.mockRejectedValueOnce(new Error('adult family verification required'));
    const adult = await app().request(
      '/api/custom/pharmacy/beta-memberships?line_account_id=account-a', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patientId: 'spouse-a', expiresAt: '2026-10-01T00:00:00.000Z' }),
      }, env,
    );
    expect(adult.status).toBe(403);

    mocks.transition.mockRejectedValueOnce(new Error('beta membership transition conflict'));
    const stale = await app().request(
      '/api/custom/pharmacy/beta-memberships/membership-1/suspend?line_account_id=account-a', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      }, env,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      success: false, error: 'Membership state changed; retry',
    });
  });
});
