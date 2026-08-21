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
  detail: vi.fn(),
  transition: vi.fn(),
  getReminderControl: vi.fn(),
  saveReminderControl: vi.fn(),
  listCounterConfirmations: vi.fn(),
  recordCounterConfirmation: vi.fn(),
  recordEmergencySale: vi.fn(),
  getEmergencySaleRecord: vi.fn(),
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
  getAdminEmergencyIntakeDetail: mocks.detail,
  transitionEmergencyIntake: mocks.transition,
  listCounterConfirmations: mocks.listCounterConfirmations,
  recordCounterConfirmation: mocks.recordCounterConfirmation,
  recordEmergencySale: mocks.recordEmergencySale,
  getEmergencySaleRecord: mocks.getEmergencySaleRecord,
}));
vi.mock('./reminders.js', () => ({
  getEmergencyReminderControl: mocks.getReminderControl,
  saveEmergencyReminderControl: mocks.saveReminderControl,
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
  mocks.listAdmin.mockResolvedValue({ intakes: [], next_cursor: null });
  mocks.detail.mockResolvedValue({
    id: 'intake-a', status: 'provisional', version: 1,
    self_reported: { intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false },
  });
  mocks.transition.mockResolvedValue({ id: 'intake-a', status: 'reviewed', version: 2 });
  mocks.getReminderControl.mockResolvedValue({
    state: 'inactive', revision: 0, timeZone: 'Asia/Tokyo', updatedAt: null,
  });
  mocks.saveReminderControl.mockResolvedValue({
    state: 'active', revision: 1, timeZone: 'Asia/Tokyo', updatedAt: '2026-08-21T00:00:00.000Z',
  });
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
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
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
      lngAllergy: false, liverDisease: false, currentlyPregnant: false, breastfeeding: false,
    }));
    expect(mocks.create.mock.calls[0][1]).not.toMatchObject({ tenantId: 'tenant-b' });
  });

  it('forwards A3/A4/A5/A-prime pre-visit flags when the client sends them', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-flags',
      lngAllergy: true, liverDisease: true, currentlyPregnant: true, breastfeeding: true,
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lngAllergy: true, liverDisease: true, currentlyPregnant: true, breastfeeding: true,
    }));
  });

  it('rejects a non-boolean pre-visit flag before it reaches the repository', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-bad-flag',
      lngAllergy: 'yes',
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('forwards B1-B4/C1-C2/D3 pre-visit fields when the client sends them', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-phase-b',
      underMedicalTreatment: true, drugAllergyHistory: true, heartKidneyGiDisease: true, stJohnsWort: true,
      lastMenstruationDate: '2026-08-01',
      menstruationSignals: {
        noneApply: false, unknown: false, overOneMonthNoPeriod: true,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
      idDocumentAvailable: true,
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      underMedicalTreatment: true, drugAllergyHistory: true, heartKidneyGiDisease: true, stJohnsWort: true,
      lastMenstruationDate: '2026-08-01',
      menstruationSignals: {
        noneApply: false, unknown: false, overOneMonthNoPeriod: true,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
      idDocumentAvailable: true,
    }));
  });

  it('defaults B1-B4/C1-C2/D3 fields when the client omits them entirely', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-phase-b-defaults',
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      underMedicalTreatment: false, drugAllergyHistory: false, heartKidneyGiDisease: false, stJohnsWort: false,
      lastMenstruationDate: null,
      menstruationSignals: {
        noneApply: false, unknown: false, overOneMonthNoPeriod: false,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
      idDocumentAvailable: null,
    }));
  });

  it('rejects a non-boolean Phase B flag before it reaches the repository', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-bad-phase-b-flag',
      underMedicalTreatment: 'yes',
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a menstruationSignals shape with a non-boolean key', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-bad-signals-shape',
      menstruationSignals: { noneApply: 'true', unknown: false, overOneMonthNoPeriod: false, notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false },
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a C2 exclusivity violation (noneApply with a signal) with 400 before calling the repository', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-exclusivity',
      menstruationSignals: {
        noneApply: true, unknown: false, overOneMonthNoPeriod: true,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a non-string, non-null lastMenstruationDate before it reaches the repository', async () => {
    const body = {
      slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00', intercourseTimeUnknown: false,
      age: 20, recentPurchaseCount: 0, patientWillVisit: true, acceptsInPersonDose: true,
      safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-bad-date',
      lastMenstruationDate: 20260801,
    };
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
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
        safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
        manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-2',
      }) }, env,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('EMERGENCY_STOCK_UNAVAILABLE');
  });

  it('maps a final-write capability rejection to FEATURE_DISABLED', async () => {
    mocks.create.mockRejectedValue(new Error('FEATURE_DISABLED'));
    const response = await app().request(
      '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
      {
        method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00',
          intercourseTimeUnknown: false, age: 20, recentPurchaseCount: 0,
          patientWillVisit: true, acceptsInPersonDose: true,
          safeContactMode: 'neutral_line', consentVersion: '2026-08-19', consentContentHash: 'hash-a',
          manufacturerCheckAcknowledged: true, idempotencyKey: 'request-key-3',
        }),
      }, env,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('maps a stale consent version or content hash to a distinct 409', async () => {
    for (const rejection of ['EMERGENCY_CONSENT_VERSION_MISMATCH', 'EMERGENCY_CONSENT_HASH_MISMATCH']) {
      mocks.create.mockRejectedValueOnce(new Error(rejection));
      const response = await app().request(
        '/api/liff/pharmacy/emergency-contraception/intakes?liffId=liff-a',
        {
          method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slotId: 'slot-a', intercourseAt: '2026-08-18T10:00:00+09:00',
            intercourseTimeUnknown: false, age: 20, recentPurchaseCount: 0,
            patientWillVisit: true, acceptsInPersonDose: true,
            safeContactMode: 'neutral_line', consentVersion: '2026-08-01', consentContentHash: 'stale-hash',
            manufacturerCheckAcknowledged: true, idempotencyKey: `request-key-consent-${rejection}`,
          }),
        }, env,
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: rejection });
    }
  });
});

describe('emergency contraception staff routes', () => {
  it('lets only owner/admin activate neutral reminders for the guarded account', async () => {
    let response = await app('staff').request(
      '/api/custom/pharmacy/emergency-contraception/reminders',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'active', expectedRevision: 0 }) }, env,
    );
    expect(response.status).toBe(403);
    response = await app('admin').request(
      '/api/custom/pharmacy/emergency-contraception/reminders',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'active', expectedRevision: 0 }) }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.saveReminderControl).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lineAccountId: 'account-a', staffId: 'staff-a', state: 'active', expectedRevision: 0,
    }));
    response = await app().request('/api/custom/pharmacy/emergency-contraception/reminders', {}, env);
    expect(response.status).toBe(200);
    expect(mocks.getReminderControl).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('allows settings changes only to owner/admin and uses the guarded account context', async () => {
    const config = {
      enabled: true, pharmacyRegistrationNumber: 'REG-A', productCode: 'norlevo-otc',
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
    expect(mocks.saveSettings.mock.calls[0]?.[1]).not.toHaveProperty('enabled');
  });

  it('maps a forced consent version bump rejection to 409', async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error('EMERGENCY_CONSENT_VERSION_STALE'));
    const response = await app('admin').request(
      '/api/custom/pharmacy/emergency-contraception/config?line_account_id=account-b',
      {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          enabled: true, pharmacyRegistrationNumber: 'REG-A', productCode: 'norlevo-otc',
          manufacturerCheckUrl: 'https://manufacturer.example/check',
          privacyPolicyUrl: 'https://example.test/privacy', privacyContact: '窓口',
          purposeText: '変更後の来局前確認と仮受付のため',
          consentVersion: '2026-08-19', retentionDays: 30, consultationMinutes: 30,
          reservationTtlMinutes: 30, privacySpaceReady: true, drinkingWaterReady: true,
          partnerClinicUrl: 'https://clinic.example', supportCenterUrl: 'https://support.example',
        }),
      }, env,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'EMERGENCY_CONSENT_VERSION_STALE' });
  });

  it('lists a bounded non-PHI queue and decrypts only the selected detail', async () => {
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes?line_account_id=account-a&status=provisional&slotId=slot-a&deadlineBefore=2026-08-22T00%3A00%3A00.000Z&limit=20', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.listAdmin).toHaveBeenCalledWith(env.DB, 'account-a', {
      status: 'provisional', slotId: 'slot-a',
      deadlineBefore: '2026-08-22T00:00:00.000Z', cursor: undefined, limit: 20,
    });
    expect(mocks.detail).not.toHaveBeenCalled();

    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.detail).toHaveBeenCalledWith(
      env.DB, 'account-a', 'intake-a', 'staff-a', 'phi-secret',
    );

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

  it('does not misreport queue storage failure as an invalid cursor', async () => {
    mocks.listAdmin.mockRejectedValueOnce(new Error('D1 unavailable'));
    const response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(503);
  });

  it('rejects malformed slot and deadline filters before repository access', async () => {
    for (const query of ['slotId=patient%20name', 'deadlineBefore=tomorrow']) {
      const response = await app().request(
        `/api/custom/pharmacy/emergency-contraception/intakes?line_account_id=account-a&${query}`, {}, env,
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.listAdmin).not.toHaveBeenCalled();
  });
});

describe('emergency contraception counter confirmation and sale routes (ECF-7)', () => {
  beforeEach(() => {
    mocks.listCounterConfirmations.mockResolvedValue([
      { section: 'A', checklist_version: 'lng-2026-08', mismatch_items: [], staff_id: 'staff-a', confirmed_at: '2026-08-22T00:00:00.000Z' },
    ]);
    mocks.recordCounterConfirmation.mockResolvedValue({
      section: 'A', checklist_version: 'lng-2026-08', mismatch_items: [], staff_id: 'staff-a', confirmed_at: '2026-08-22T00:00:00.000Z',
    });
    mocks.recordEmergencySale.mockResolvedValue({ id: 'sale-a', outcome: 'sold', sold_at: '2026-08-22T00:00:00.000Z' });
    mocks.getEmergencySaleRecord.mockResolvedValue({
      id: 'sale-a', outcome: 'sold', sold_at: '2026-08-22T00:00:00.000Z', product_code: 'norlevo-otc',
      checklist_version: 'lng-2026-08', identity_check: 'document', in_person_dose: 'done',
      checklist_sheets_received: 1, pharmacist_staff_id: 'staff-a', training_registration_number: 'TRAIN-A',
      pregnancy_test: 'negative', refusal_reason_code: null, referral: 'none', explained: [],
    });
  });

  it('reads and writes a section counter confirmation scoped to the intake', async () => {
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/A?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.listCounterConfirmations).toHaveBeenCalledWith(env.DB, 'account-a', 'intake-a', 'staff-a');

    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/A?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checklistVersion: 'lng-2026-08', mismatchItems: ['A3'] }) }, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.recordCounterConfirmation).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', intakeId: 'intake-a', section: 'A',
      checklistVersion: 'lng-2026-08', mismatchItems: ['A3'], staffId: 'staff-a',
    });
  });

  it('rejects an out-of-range section before repository access', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/E?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.listCounterConfirmations).not.toHaveBeenCalled();
  });

  it('maps an untrained staff read to 403', async () => {
    mocks.listCounterConfirmations.mockRejectedValueOnce(new Error('trained pharmacist access required'));
    const response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/A?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(403);
  });

  it('maps counter confirmation failures to 403/404/409', async () => {
    mocks.recordCounterConfirmation.mockRejectedValueOnce(new Error('trained pharmacist access required'));
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/A?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checklistVersion: 'v1', mismatchItems: [] }) }, env,
    );
    expect(response.status).toBe(403);

    mocks.recordCounterConfirmation.mockRejectedValueOnce(new Error('intake not found'));
    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/A?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checklistVersion: 'v1', mismatchItems: [] }) }, env,
    );
    expect(response.status).toBe(404);

    mocks.recordCounterConfirmation.mockRejectedValueOnce(new Error('counter confirmation exists'));
    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/counter-confirmations/A?line_account_id=account-a',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checklistVersion: 'v1', mismatchItems: [] }) }, env,
    );
    expect(response.status).toBe(409);
  });

  it('records a sale and reads it back scoped to the staff line account', async () => {
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        expectedVersion: 2, outcome: 'sold', identityCheck: 'document', inPersonDose: 'done',
        checklistSheetsReceived: 1, pregnancyTest: 'negative', refusalReasonCode: null,
        referral: 'none', explained: ['three_week_check'],
      }) }, env,
    );
    expect(response.status).toBe(201);
    expect(mocks.recordEmergencySale).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', intakeId: 'intake-a', staffId: 'staff-a', expectedVersion: 2,
      outcome: 'sold', identityCheck: 'document', inPersonDose: 'done', checklistSheetsReceived: 1,
      pregnancyTest: 'negative', refusalReasonCode: null, referral: 'none',
      explained: ['three_week_check'], encryptionSecret: 'phi-secret',
    });

    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.getEmergencySaleRecord).toHaveBeenCalledWith(env.DB, 'account-a', 'intake-a', 'staff-a', 'phi-secret');
  });

  it('fails closed without the PHI key on the sale endpoints', async () => {
    const noKeyEnv = { ...env, PHARMACY_PHI_KEY_V1: undefined };
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }, noKeyEnv,
    );
    expect(response.status).toBe(503);
    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a', {}, noKeyEnv,
    );
    expect(response.status).toBe(503);
    expect(mocks.recordEmergencySale).not.toHaveBeenCalled();
    expect(mocks.getEmergencySaleRecord).not.toHaveBeenCalled();
  });

  it('rejects a malformed sale body before repository access', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) }, env,
    );
    expect(response.status).toBe(400);
    expect(mocks.recordEmergencySale).not.toHaveBeenCalled();
  });

  it('maps sale failures to 403/404/409', async () => {
    const body = JSON.stringify({
      expectedVersion: 2, outcome: 'sold', identityCheck: 'document', inPersonDose: 'done',
      checklistSheetsReceived: 1, pregnancyTest: 'negative', refusalReasonCode: null,
      referral: 'none', explained: [],
    });
    mocks.recordEmergencySale.mockRejectedValueOnce(new Error('trained pharmacist access required'));
    let response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, env,
    );
    expect(response.status).toBe(403);

    mocks.recordEmergencySale.mockRejectedValueOnce(new Error('intake not found'));
    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, env,
    );
    expect(response.status).toBe(404);

    mocks.recordEmergencySale.mockRejectedValueOnce(new Error('transition conflict'));
    response = await app().request(
      '/api/custom/pharmacy/emergency-contraception/intakes/intake-a/sale?line_account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, env,
    );
    expect(response.status).toBe(409);
  });
});
