import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolvePatient: vi.fn(),
  betaParticipant: vi.fn(),
  listFeatures: vi.fn(),
}));

vi.mock('../../services/liff-auth.js', () => ({
  verifyCallerLineIdentity: mocks.verify,
  verifyCallerLineUserId: vi.fn(),
}));
vi.mock('../../custom/pharmacy/prescriptions/patient.js', () => ({
  resolvePrescriptionPatient: mocks.resolvePatient,
}));
vi.mock('../../custom/pharmacy/beta-membership/repository.js', () => ({
  canUsePharmacyBetaParticipant: mocks.betaParticipant,
}));
vi.mock('../../custom/pharmacy/growth-loop/patient-feature-access.js', () => ({
  listExistingPatientFeatures: mocks.listFeatures,
}));

import { liffRoutes } from './liff.js';

const env = { DB: {} as D1Database };
const owner = { lineAccountId: 'account-1', friendId: 'friend-1' };

describe('LIFF pharmacy feature-access boundary', () => {
  const request = () => {
    const app = new Hono<Env>();
    app.route('/', liffRoutes);
    return app.request('/api/liff/pharmacy/feature-access?liffId=liff-1', {
      headers: { Authorization: 'Bearer token' },
    }, env as Env['Bindings']);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue({
      lineUserId: 'U1', loginChannelId: 'login-1', tenantId: 'tenant-1', lineAccountId: 'account-1',
    });
    mocks.resolvePatient.mockResolvedValue(owner);
    mocks.betaParticipant.mockResolvedValue(true);
    mocks.listFeatures.mockResolvedValue(['prescription_intake']);
  });

  it('returns an empty feature list instead of 403 for a non-participant', async () => {
    mocks.betaParticipant.mockResolvedValue(false);
    const response = await request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { existingFeatures: [] },
    });
    expect(mocks.betaParticipant).toHaveBeenCalledWith(env.DB, 'account-1', 'friend-1');
    expect(mocks.listFeatures).not.toHaveBeenCalled();
  });

  it('returns scoped features for a participant', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { existingFeatures: ['prescription_intake'] },
    });
    expect(mocks.listFeatures).toHaveBeenCalledWith(env.DB, owner);
  });
});
