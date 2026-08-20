import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolve: vi.fn(),
  overview: vi.fn(),
  create: vi.fn(),
  listOwner: vi.fn(),
  cancelOwner: vi.fn(),
  adminConfig: vi.fn(),
  saveSettings: vi.fn(),
  setPharmacist: vi.fn(),
  createSlot: vi.fn(),
  cancelSlot: vi.fn(),
  setInventory: vi.fn(),
  listAdmin: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('./repository.js', () => ({
  getEmergencyServiceOverview: mocks.overview,
  createEmergencyIntake: mocks.create,
  listOwnerEmergencyIntakes: mocks.listOwner,
  cancelOwnerEmergencyIntake: mocks.cancelOwner,
  getEmergencyAdminConfig: mocks.adminConfig,
  saveEmergencySettings: mocks.saveSettings,
  setEmergencyPharmacist: mocks.setPharmacist,
  createEmergencySlot: mocks.createSlot,
  cancelEmergencySlot: mocks.cancelSlot,
  setEmergencyInventory: mocks.setInventory,
  listAdminEmergencyIntakes: mocks.listAdmin,
  transitionEmergencyIntake: mocks.transition,
}));

import { emergencyContraceptionRoutes } from './routes.js';

const env = { DB: {} as D1Database, PHARMACY_PHI_KEY_V1: 'phi-secret' };

function app(role: 'owner' | 'admin' | 'staff' = 'admin') {
  const root = new Hono<any>();
  root.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-a', name: 'Staff A', role });
    c.set('tenantId', 'tenant-a');
    c.set('pharmacyTenantId', 'tenant-a');
    c.set('pharmacyLineAccountId', 'account-a');
    await next();
  });
  root.route('/', emergencyContraceptionRoutes);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue({
    lineUserId: 'U-a', loginChannelId: 'login-a', tenantId: 'tenant-a', lineAccountId: 'account-a',
  });
  mocks.resolve.mockResolvedValue({ lineAccountId: 'account-a', friendId: 'friend-a' });
  mocks.overview.mockResolvedValue({
    ready: true, reason: null,
    consent: { version: '2026-08-19', retention_days: 30, privacy_policy_url: 'https://example.test/privacy', privacy_contact: '窓口' },
    manufacturer_check_url: 'https://manufacturer.example/check',
    partner_clinic_url: 'https://clinic.example', support_center_url: 'https://support.example',
    slots: [{ id: 'slot-a', starts_at: '2026-08-20T00:00:00.000Z', ends_at: '2026-08-20T00:30:00.000Z', remaining: 1 }],
  });
  mocks.listOwner.mockResolvedValue([]);
  mocks.create.mockResolvedValue({
    id: 'intake-a', reference_code: 'EC-ABCDEFGHJKLMNPQR', status: 'provisional', version: 1,
  });
  mocks.cancelOwner.mockResolvedValue({ id: 'intake-a', status: 'cancelled', version: 2 });
  mocks.adminConfig.mockResolvedValue({ settings: null, pharmacists: [], inventory: [], slots: [] });
  mocks.listAdmin.mockResolvedValue([]);
  mocks.transition.mockResolvedValue({ id: 'intake-a', status: 'reviewed', version: 2 });
});

describe('emergency contraception patient routes', () => {
  it('derives tenant, account, and owner from the verified LIFF identity', async () => {
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception?liffId=liff-a',
      { headers: { Authorization: 'Bearer id-token-a' } }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(env.DB, 'liff-a', expect.objectContaining({
      tenantId: 'tenant-a', lineAccountId: 'account-a',
    }));
    expect(mocks.overview).toHaveBeenCalledWith(env.DB, 'account-a');
    expect(mocks.listOwner).toHaveBeenCalledWith(env.DB, 'account-a', 'friend-a');
  });

  it('creates a minimal encrypted provisional intake without trusting body tenant fields', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-1',
      tenantId: 'tenant-b', lineAccountId: 'account-b', friendId: 'friend-b',
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      tenantId: 'tenant-a', lineAccountId: 'account-a', friendId: 'friend-a',
      encryptionSecret: 'phi-secret', idempotencyKey: 'request-key-1',
    }));
    expect(mocks.create.mock.calls[0][1]).not.toMatchObject({ tenantId: 'tenant-b' });
  });

  it('fails closed without the PHI key and never exposes repository details', async () => {
    let response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: '{}' },
      { ...env, PHARMACY_PHI_KEY_V1: undefined },
    );
    expect(response.status).toBe(503);
    mocks.create.mockRejectedValueOnce(new Error('EMERGENCY_STOCK_UNAVAILABLE secret detail'));
    response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify({
        slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
        age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
        safeContactMode: 'neutral_line', consentVersion: '2026-08-19',
        manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-2',
      }) }, env,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('EMERGENCY_STOCK_UNAVAILABLE');
  });
});

describe('emergency contraception staff routes', () => {
  it('allows settings changes only to owner/admin and uses the guarded account context', async () => {
    const config = {
      enabled: false, pharmacyRegistrationNumber: 'REG-A', productCode: 'norlevo-otc',
      manufacturerCheckUrl: 'https://manufacturer.example/check',
      privacyPolicyUrl: 'https://example.test/privacy', privacyContact: '窓口',
      purposeText: '来局前確認と仮受付のため',
      consentVersion: '2026-08-19', retentionDays: 30, consultationMinutes: 30,
      reservationTtlMinutes: 30, privacySpaceReady: true, drinkingWaterReady: true,
      partnerClinicUrl: 'https://clinic.example', supportCenterUrl: 'https://support.example',
    };
    let response = await app('staff').request(
      '/api/custom/pharmacy/emergency-contraception/config?line_account_id=account-b',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }, env,
    );
    expect(response.status).toBe(403);
    response = await app('admin').request(
      '/api/custom/pharmacy/emergency-contraception/config?line_account_id=account-b',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }, env,
    );
    expect(response.status).toBe(204);
    expect(mocks.saveSettings).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lineAccountId: 'account-a', staffId: 'staff-a', productCode: 'norlevo-otc',
      purposeText: '来局前確認と仮受付のため',
    }));
  });

  it('limits decrypted queue access and CAS transitions to repository-enforced trained pharmacists', async () => {
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.listAdmin).toHaveBeenCalledWith(env.DB, 'account-a', 'staff-a', 'phi-secret');

    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/transitions?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'reviewed', expectedVersion: 1 }) }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', intakeId: 'intake-a', expectedVersion: 1,
      toStatus: 'reviewed', staffId: 'staff-a',
    });
  });
});
