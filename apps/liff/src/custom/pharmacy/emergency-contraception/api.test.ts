import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('../request.js', () => ({ requestPharmacyJson: request }));

import { emergencyContraceptionApi } from './api.js';

beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ service: { ready: false }, intakes: [] });
});

describe('emergency contraception patient API', () => {
  it('lists the verified owner service and provisional intakes', async () => {
    await emergencyContraceptionApi.list();
    expect(request).toHaveBeenCalledWith(
      '/api/liff/pharmacy/emergency-contraception',
      undefined,
    );
  });

  it('sends only the Phase 1 minimum intake fields', async () => {
    const body = {
      slotId: 'slot-1',
      intercourseAt: '2026-08-18T10:00:00.000Z',
      intercourseTimeUnknown: false,
      age: 20,
      recentPurchaseCount: 0,
      patientWillVisit: true,
      acceptsInPersonDose: true,
      lngAllergy: false,
      liverDisease: false,
      currentlyPregnant: false,
      breastfeeding: false,
      underMedicalTreatment: false,
      drugAllergyHistory: false,
      heartKidneyGiDisease: false,
      stJohnsWort: false,
      lastMenstruationDate: null,
      menstruationSignals: {
        noneApply: false, unknown: false, overOneMonthNoPeriod: false,
        notRecoveredAfterBirth: false, lastPeriodDifferent: false, earlierConcernOver3Weeks: false,
      },
      idDocumentAvailable: null,
      safeContactMode: 'neutral_line' as const,
      consentVersion: '2026-08-19',
      consentContentHash: 'hash-a',
      manufacturerCheckAcknowledged: true,
      idempotencyKey: 'create-key-1',
    };
    await emergencyContraceptionApi.create(body);
    expect(request).toHaveBeenCalledWith(
      '/api/liff/pharmacy/emergency-contraception/intakes',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  });

  it('cancels an owner intake with its version and idempotency key', async () => {
    await emergencyContraceptionApi.cancel('intake/1', 3, 'cancel-key-1');
    expect(request).toHaveBeenCalledWith(
      '/api/liff/pharmacy/emergency-contraception/intakes/intake%2F1/cancel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 3, idempotencyKey: 'cancel-key-1' }),
      }),
    );
  });
});
