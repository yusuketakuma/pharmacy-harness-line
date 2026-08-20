import { describe, expect, it } from 'vitest';
import { assessEmergencyPrecheck } from './policy.js';

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
