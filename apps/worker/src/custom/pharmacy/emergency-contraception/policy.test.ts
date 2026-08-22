import { describe, expect, it } from 'vitest';
import { assessEmergencyPrecheck, validMenstruationSignals } from './policy.js';

const noSignals = {
  noneApply: false,
  unknown: false,
  overOneMonthNoPeriod: false,
  notRecoveredAfterBirth: false,
  lastPeriodDifferent: false,
  earlierConcernOver3Weeks: false,
};

const base = {
  intercourseAt: '2026-08-18T10:00:00+09:00',
  intercourseTimeUnknown: false,
  slotStartsAt: '2026-08-21T09:30:00+09:00',
  consultationMinutes: 30,
  age: 20,
  recentPurchaseCount: 0,
  patientWillVisit: true,
  acceptsInPersonDose: true,
  safeContactAvailable: true,
  lngAllergy: false,
  liverDisease: false,
  currentlyPregnant: false,
  breastfeeding: false,
  underMedicalTreatment: false,
  drugAllergyHistory: false,
  heartKidneyGiDisease: false,
  stJohnsWort: false,
  lastMenstruationDate: '2026-08-01',
  menstruationSignals: noSignals,
  now: new Date('2026-08-19T10:00:00+09:00'),
};

describe('assessEmergencyPrecheck', () => {
  it('uses the estimated dose time, not arrival time, at the 72-hour boundary', () => {
    expect(assessEmergencyPrecheck(base)).toMatchObject({
      estimatedDoseAt: '2026-08-21T01:00:00.000Z',
      deadlineAt: '2026-08-21T01:00:00.000Z',
      canCreateProvisional: true,
    });

    expect(assessEmergencyPrecheck({
      ...base,
      consultationMinutes: 31,
    })).toMatchObject({
      canCreateProvisional: false,
      blockingReason: 'outside_72_hours',
    });
  });

  it('treats an unknown time as 00:00 JST and flags it for pharmacist review', () => {
    const result = assessEmergencyPrecheck({
      ...base,
      intercourseAt: '2026-08-18',
      intercourseTimeUnknown: true,
      slotStartsAt: '2026-08-20T23:00:00+09:00',
    });

    expect(result.deadlineAt).toBe('2026-08-20T15:00:00.000Z');
    expect(result.riskFlags).toContain('time_unknown');
  });

  it('routes age and repeated use to human review without making a sale decision', () => {
    const result = assessEmergencyPrecheck({
      ...base,
      age: 15,
      recentPurchaseCount: 1,
    });

    expect(result.canCreateProvisional).toBe(true);
    expect(result.riskFlags).toEqual(expect.arrayContaining([
      'under_16',
      'repeat_purchase_review',
    ]));
    expect(result).not.toHaveProperty('eligible');
  });

  it('flags unavailable notifications without blocking the provisional intake', () => {
    const result = assessEmergencyPrecheck({ ...base, safeContactAvailable: false });

    expect(result.canCreateProvisional).toBe(true);
    expect(result.riskFlags).toContain('notification_unavailable');
  });

  it.each([
    ['patient_presence_required', { patientWillVisit: false }],
    ['in_person_dose_required', { acceptsInPersonDose: false }],
  ] as const)('blocks provisional intake when %s', (blockingReason, override) => {
    expect(assessEmergencyPrecheck({ ...base, ...override })).toMatchObject({
      canCreateProvisional: false,
      blockingReason,
    });
  });

  it('rejects future or malformed intercourse timestamps', () => {
    expect(() => assessEmergencyPrecheck({
      ...base,
      intercourseAt: '2026-08-20T10:00:00+09:00',
    })).toThrow('invalid intercourse time');
    expect(() => assessEmergencyPrecheck({ ...base, intercourseAt: 'not-a-date' }))
      .toThrow('invalid intercourse time');
  });
});

describe('assessEmergencyPrecheck v2 pre-review flags (A3/A4/A5/A-prime)', () => {
  it('adds no detail flags and omits pre_review_flagged when none apply', () => {
    const result = assessEmergencyPrecheck(base);
    expect(result.detailFlags).toEqual([]);
    expect(result.riskFlags).not.toContain('pre_review_flagged');
    expect(result.canCreateProvisional).toBe(true);
    expect(result).not.toHaveProperty('eligible');
  });

  it.each([
    ['lngAllergy', 'lng_allergy'],
    ['liverDisease', 'liver_disease'],
    ['currentlyPregnant', 'pregnancy_reported'],
    ['breastfeeding', 'breastfeeding_advice'],
  ] as const)('flags %s as a payload-internal detail without changing canCreateProvisional', (field, detailFlag) => {
    const result = assessEmergencyPrecheck({ ...base, [field]: true });
    expect(result.canCreateProvisional).toBe(true);
    expect(result.riskFlags).toContain('pre_review_flagged');
    expect(result.detailFlags).toContain(detailFlag);
    expect(result).not.toHaveProperty('eligible');
  });
});

describe('assessEmergencyPrecheck v2 pre-review flags (B1-B4)', () => {
  it.each([
    ['underMedicalTreatment', 'under_medical_treatment'],
    ['drugAllergyHistory', 'drug_allergy_history'],
    ['heartKidneyGiDisease', 'heart_kidney_gi_disease'],
    ['stJohnsWort', 'st_johns_wort'],
  ] as const)('flags %s as a payload-internal detail without changing canCreateProvisional', (field, detailFlag) => {
    const result = assessEmergencyPrecheck({ ...base, [field]: true });
    expect(result.canCreateProvisional).toBe(true);
    expect(result.riskFlags).toContain('pre_review_flagged');
    expect(result.detailFlags).toContain(detailFlag);
    expect(result).not.toHaveProperty('eligible');
  });

  it('omits pre_review_flagged when no A or B flag applies', () => {
    const result = assessEmergencyPrecheck(base);
    expect(result.riskFlags).not.toContain('pre_review_flagged');
  });
});

describe('assessEmergencyPrecheck pregnancy test recommendation (C1/C2)', () => {
  it('recommends a test when the last menstruation date is unknown (null)', () => {
    const result = assessEmergencyPrecheck({ ...base, lastMenstruationDate: null, menstruationSignals: noSignals });
    expect(result.pregnancyTestRecommended).toBe(true);
    expect(result.riskFlags).not.toContain('pregnancy_test_recommended' as never);
  });

  it('recommends a test when the unknown checkbox is checked', () => {
    const result = assessEmergencyPrecheck({
      ...base, menstruationSignals: { ...noSignals, unknown: true },
    });
    expect(result.pregnancyTestRecommended).toBe(true);
  });

  it.each([
    'overOneMonthNoPeriod', 'notRecoveredAfterBirth', 'lastPeriodDifferent', 'earlierConcernOver3Weeks',
  ] as const)('recommends a test when %s is checked', (signal) => {
    const result = assessEmergencyPrecheck({
      ...base, menstruationSignals: { ...noSignals, [signal]: true },
    });
    expect(result.pregnancyTestRecommended).toBe(true);
  });

  it('does not recommend a test when none apply and the date is known', () => {
    const result = assessEmergencyPrecheck({
      ...base, lastMenstruationDate: '2026-08-01', menstruationSignals: { ...noSignals, noneApply: true },
    });
    expect(result.pregnancyTestRecommended).toBe(false);
  });

  it('never leaks pregnancy_test_recommended into risk_flags_json (plaintext)', () => {
    const result = assessEmergencyPrecheck({
      ...base, lastMenstruationDate: null, menstruationSignals: { ...noSignals, unknown: false },
    });
    expect(result.riskFlags).not.toContain('pregnancy_test_recommended' as never);
  });
});

describe('validMenstruationSignals exclusivity', () => {
  it('accepts an unanswered C2 (noneApply/unknown/signals all unset) but recommends a test as the safe default', () => {
    expect(validMenstruationSignals(noSignals)).toBe(true);
    const result = assessEmergencyPrecheck({ ...base, lastMenstruationDate: '2026-08-01', menstruationSignals: noSignals });
    expect(result.pregnancyTestRecommended).toBe(true);
  });

  it('accepts multiple positive signals together', () => {
    expect(validMenstruationSignals({
      ...noSignals, overOneMonthNoPeriod: true, lastPeriodDifferent: true,
    })).toBe(true);
  });

  it('rejects noneApply combined with unknown', () => {
    expect(validMenstruationSignals({ ...noSignals, noneApply: true, unknown: true })).toBe(false);
  });

  it('rejects noneApply combined with any signal', () => {
    expect(validMenstruationSignals({ ...noSignals, noneApply: true, overOneMonthNoPeriod: true })).toBe(false);
  });

  it('rejects unknown combined with any signal', () => {
    expect(validMenstruationSignals({ ...noSignals, unknown: true, lastPeriodDifferent: true })).toBe(false);
  });
});
