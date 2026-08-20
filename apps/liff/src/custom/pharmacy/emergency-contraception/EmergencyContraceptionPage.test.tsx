import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import EmergencyContraceptionPage, {
  EMPTY_EMERGENCY_DRAFT,
  MHLW_EMERGENCY_CONTRACEPTION_URL,
  canSubmitEmergencyIntake,
  toIntercourseAtPayload,
  type EmergencyIntakeDraft,
} from './EmergencyContraceptionPage.js';

const completeDraft: EmergencyIntakeDraft = {
  ...EMPTY_EMERGENCY_DRAFT,
  intercourseAt: '2026-08-18T10:00',
  intercourseTimeUnknown: false,
  slotId: 'slot-1',
  age: '20',
  recentPurchaseCount: '0',
  patientWillVisit: true,
  acceptsInPersonDose: true,
  safeContactMode: 'neutral_line',
  manufacturerCheckAcknowledged: true,
};

describe('emergency contraception patient page', () => {
  it('keeps explicit consent and patient-presence confirmations false initially', () => {
    expect(EMPTY_EMERGENCY_DRAFT.consentAccepted).toBe(false);
    expect(EMPTY_EMERGENCY_DRAFT.manufacturerCheckAcknowledged).toBe(false);
    expect(EMPTY_EMERGENCY_DRAFT.patientWillVisit).toBe(false);
    expect(EMPTY_EMERGENCY_DRAFT.acceptsInPersonDose).toBe(false);
    expect(canSubmitEmergencyIntake(completeDraft)).toBe(false);
    expect(canSubmitEmergencyIntake({ ...completeDraft, consentAccepted: true })).toBe(true);
  });

  it('requires the minimum fields and fixed safe contact choice', () => {
    const consented = { ...completeDraft, consentAccepted: true };
    expect(canSubmitEmergencyIntake({ ...consented, slotId: '' })).toBe(false);
    expect(canSubmitEmergencyIntake({ ...consented, safeContactMode: '' })).toBe(false);
    expect(canSubmitEmergencyIntake({ ...consented, age: '15.5' })).toBe(false);
    expect(canSubmitEmergencyIntake({ ...consented, intercourseAt: '' })).toBe(false);
    expect(canSubmitEmergencyIntake({ ...consented, intercourseTimeUnknown: true, intercourseAt: '2026-08-18' })).toBe(true);
  });

  it('sends local form time as explicit JST instead of the device timezone', () => {
    expect(toIntercourseAtPayload({ intercourseAt: '2026-08-18T10:00', intercourseTimeUnknown: false }))
      .toBe('2026-08-18T10:00:00+09:00');
    expect(toIntercourseAtPayload({ intercourseAt: '2026-08-18', intercourseTimeUnknown: true }))
      .toBe('2026-08-18');
  });

  it('communicates a provisional, no-guarantee flow with external alternatives', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter><EmergencyContraceptionPage /></MemoryRouter>,
    );
    expect(html).toContain('緊急避妊薬の来局前確認');
    expect(html).toContain('仮受付');
    expect(html).toContain('販売・服用・在庫を保証しません');
    expect(html).toContain('厚生労働省');
    expect(html).toContain(MHLW_EMERGENCY_CONTRACEPTION_URL);
    expect(html).not.toContain('病歴');
  });

  it('uses explicit consent without delaying time-sensitive care and keeps actions single-flight', () => {
    const source = readFileSync(new URL('./EmergencyContraceptionPage.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('service.consent.purpose');
    expect(source).toContain('service.consent.retention_days');
    expect(source).toContain('service.consent.privacy_contact');
    expect(source).toContain("setBusy('submit')");
    expect(source).not.toContain('setInterval');
    expect(source).toContain('crypto.randomUUID()');
    expect(app).toContain("import EmergencyContraceptionPage from './custom/pharmacy/emergency-contraception/EmergencyContraceptionPage.js'; // custom:pharmacy-emergency-contraception");
    expect(app).toContain('<Route path="/pharmacy/emergency-contraception" element={<EmergencyContraceptionPage />} /> {/* custom:pharmacy-emergency-contraception */}');
  });
});
