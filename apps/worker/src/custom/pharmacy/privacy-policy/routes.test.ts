import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolve: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('./repository.js', () => ({
  getTenantPrivacyPolicy: mocks.get,
  saveTenantPrivacyPolicy: mocks.save,
}));

import { pharmacyPrivacyPolicyRoutes } from './routes.js';

const env = { DB: {} as D1Database };

const POLICY = {
  line_account_id: 'account-a',
  purpose_text: '調剤・服薬指導および連絡のために利用します。',
  purpose_url: 'https://pharmacy-a.example/privacy',
  contact_point: '薬局A 個人情報相談窓口',
  entrustment_text: 'システム運営事業者に業務の一部を委託しています。',
  policy_version: 3,
  content_hash: 'a'.repeat(64),
  updated_at: '2026-08-20T00:00:00.000Z',
};

const INPUT = {
  purposeText: POLICY.purpose_text,
  purposeUrl: POLICY.purpose_url,
  contactPoint: POLICY.contact_point,
  entrustmentText: POLICY.entrustment_text,
};

function app(role: 'owner' | 'admin' | 'staff' = 'admin') {
  const root = new Hono<never>();
  root.use('*', async (c, next) => {
    c.set('staff' as never, { id: 'staff-a', name: 'Staff A', role } as never);
    c.set('pharmacyLineAccountId' as never, 'account-a' as never);
    await next();
  });
  root.route('/', pharmacyPrivacyPolicyRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({
    lineUserId: 'U-a', loginChannelId: 'login-a', tenantId: 'tenant-a', lineAccountId: 'account-a',
  });
  mocks.resolve.mockResolvedValue({ lineAccountId: 'account-a', friendId: 'friend-a' });
  mocks.get.mockResolvedValue(POLICY);
  mocks.save.mockResolvedValue(undefined);
});

describe('pharmacy tenant privacy policy routes', () => {
  it('returns the tenant notice to its own admin', async () => {
    const res = await app().request('/api/custom/pharmacy/privacy-policy', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ policy: POLICY });
    expect(mocks.get).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('saves the notice under the acting tenant scope, never a request-supplied one', async () => {
    const res = await app().request('/api/custom/pharmacy/privacy-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INPUT, lineAccountId: 'account-b' }),
    }, env);
    expect(res.status).toBe(204);
    expect(mocks.save).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', staffId: 'staff-a', ...INPUT,
    });
  });

  it('rejects a non-admin editor', async () => {
    const res = await app('staff').request('/api/custom/pharmacy/privacy-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INPUT),
    }, env);
    expect(res.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('reports invalid notice content as 400', async () => {
    mocks.save.mockRejectedValue(new Error('invalid privacy policy'));
    const res = await app().request('/api/custom/pharmacy/privacy-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INPUT, purposeText: '' }),
    }, env);
    expect(res.status).toBe(400);
  });

  it('exposes the notice to the LIFF patient consent screen', async () => {
    const res = await app().request('/api/liff/pharmacy/privacy-policy?liffId=liff-a', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      policy: {
        purpose_text: POLICY.purpose_text,
        purpose_url: POLICY.purpose_url,
        contact_point: POLICY.contact_point,
        entrustment_text: POLICY.entrustment_text,
        policy_version: POLICY.policy_version,
      },
    });
  });

  it('returns a null notice rather than an error when the tenant published none', async () => {
    mocks.get.mockResolvedValue(null);
    const res = await app().request('/api/liff/pharmacy/privacy-policy?liffId=liff-a', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ policy: null });
  });

  it('rejects an unauthenticated LIFF caller', async () => {
    mocks.verify.mockResolvedValue(null);
    const res = await app().request('/api/liff/pharmacy/privacy-policy?liffId=liff-a', {}, env);
    expect(res.status).toBe(401);
  });
});
