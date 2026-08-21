import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmergencyContraceptionPage, {
  EMPTY_EMERGENCY_DRAFT,
  EmergencyIntakeForm,
  MHLW_EMERGENCY_CONTRACEPTION_URL,
  canSubmitEmergencyIntake,
  emergencyIntakeFieldErrors,
  emergencyNextAction,
  toIntercourseAtPayload,
  type EmergencyIntakeDraft,
} from './EmergencyContraceptionPage.js';
import type { EmergencyServiceOverview } from './api.js';

const readyService: EmergencyServiceOverview = {
  ready: true,
  reason: null,
  consent: {
    version: '2026-08-19',
    purpose: '来局前確認と仮受付のため',
    retention_days: 90,
    privacy_policy_url: 'https://example.com/privacy',
    privacy_contact: 'privacy@example.com',
  },
  manufacturer_check_url: 'https://example.com/self-check',
  partner_clinic_url: null,
  support_center_url: null,
  slots: [{ id: 'slot-1', starts_at: '2026-08-18T10:00:00+09:00', ends_at: '2026-08-18T10:30:00+09:00', remaining: 1 }],
};

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
    expect(html).toContain('緊急避妊薬');
    expect(html).toContain('仮受付');
    expect(html).toContain('販売・服用・在庫を保証しません');
    expect(html).toContain('厚生労働省');
    expect(html).toContain(MHLW_EMERGENCY_CONTRACEPTION_URL);
    expect(html).not.toContain('病歴');
  });

  it('keeps the mounted intake form content-neutral about the drug, intercourse, and pregnancy', () => {
    const renderForm = (draft: EmergencyIntakeDraft) => renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={draft}
        service={readyService}
        busy={null}
        onDraftChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    const withTime = renderForm({ ...completeDraft, consentAccepted: true });
    const dateOnly = renderForm({
      ...completeDraft, consentAccepted: true, intercourseTimeUnknown: true, intercourseAt: '2026-08-18',
    });

    expect(withTime).toContain('対象となる出来事の日時');
    expect(withTime).toContain('出来事があった日時');
    expect(dateOnly).toContain('出来事があった日');
    for (const html of [withTime, dateOnly]) {
      expect(html).not.toMatch(/性交|妊娠|緊急避妊/);
    }

    expect(() => toIntercourseAtPayload({ intercourseAt: '', intercourseTimeUnknown: false }))
      .toThrow(/^対象となる出来事の日時/);
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
    expect(app).toContain('<Route path="/pharmacy/emergency-contraception" element={<PharmacyPage screenTitle="緊急避妊薬" capability="emergency_contraception" allowExisting><EmergencyContraceptionPage /></PharmacyPage>} /> {/* custom:pharmacy-emergency-contraception */}');
  });

  it('shows a server-timed status card with the next patient action', () => {
    expect(emergencyNextAction('provisional')).toContain('薬剤師の確認')
    expect(emergencyNextAction('reviewed')).toContain('本人が来局')
    expect(emergencyNextAction('expired')).toContain('新しい対応枠')
    const source = readFileSync(new URL('./EmergencyContraceptionPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('サーバー確認時刻')
    expect(source).toContain('serverNow')
  });
});

describe('emergency intake submit flow (WP-12)', () => {
  it('reports a neutral message for each unmet field', () => {
    expect(emergencyIntakeFieldErrors(EMPTY_EMERGENCY_DRAFT)).toEqual({
      intercourseAt: '出来事があった日時を入力してください',
      slotId: '希望する対応枠を選んでください',
      age: '年齢を0〜120の整数で入力してください',
      recentPurchaseCount: '過去3か月の利用回数を0以上の整数で入力してください',
      patientWillVisit: '「本人が薬局へ来局します」にチェックしてください',
      acceptsInPersonDose: '「薬剤師の面前で服用します」にチェックしてください',
      safeContactMode: '連絡方法をどちらか選んでください',
      manufacturerCheckAcknowledged: 'セルフチェックの確認にチェックしてください',
      consentAccepted: '説明と利用目的への同意にチェックしてください',
    });
    expect(emergencyIntakeFieldErrors({ ...completeDraft, consentAccepted: true })).toEqual({});
    for (const message of Object.values(emergencyIntakeFieldErrors(EMPTY_EMERGENCY_DRAFT))) {
      expect(message).not.toMatch(/性交|妊娠|緊急避妊/);
    }
  });

  it('keeps the form visible before consent and disables submit until consent is given', () => {
    const source = readFileSync(new URL('./EmergencyContraceptionPage.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('{draft.consentAccepted && <EmergencyIntakeForm');
    const html = renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={completeDraft}
        service={readyService}
        busy={null}
        onDraftChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(html).toMatch(/<button type="submit" disabled=""/);
    expect(html).not.toContain('同意にチェックしてください');
    const afterAttempt = renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={completeDraft}
        service={readyService}
        busy={null}
        showErrors
        onDraftChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(afterAttempt).toContain('同意にチェックしてください');
  });

  it('shows field-level errors next to the field after a failed attempt', () => {
    const html = renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={{ ...EMPTY_EMERGENCY_DRAFT, consentAccepted: true }}
        service={readyService}
        busy={null}
        showErrors
        onDraftChange={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(html).toContain('希望する対応枠を選んでください');
    expect(html).toContain('年齢を0〜120の整数で入力してください');
    expect(html).toContain('aria-invalid="true"');
  });

  it('confirms before sending and shows next steps after success', () => {
    const source = readFileSync(new URL('./EmergencyContraceptionPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('送信内容の確認');
    expect(source).toContain('この内容で送信する');
    expect(source).toContain('window.scrollTo(0, 0)');
    expect(source).toContain('次にすること');
  });
});

describe('emergency contraception phase A flags (ECF-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00+09:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults the A3/A4/A5/A-prime flags to false and never blocks submission', () => {
    expect(EMPTY_EMERGENCY_DRAFT.lngAllergy).toBe(false);
    expect(EMPTY_EMERGENCY_DRAFT.liverDisease).toBe(false);
    expect(EMPTY_EMERGENCY_DRAFT.currentlyPregnant).toBe(false);
    expect(EMPTY_EMERGENCY_DRAFT.breastfeeding).toBe(false);
    const draft = {
      ...completeDraft, consentAccepted: true,
      lngAllergy: true, liverDisease: true, currentlyPregnant: true, breastfeeding: true,
    };
    expect(canSubmitEmergencyIntake(draft)).toBe(true);
    expect(emergencyIntakeFieldErrors(draft)).toEqual({});
  });

  it('renders neutral-wording checkboxes for the flags without the banned vocabulary', () => {
    const draft = {
      ...completeDraft, consentAccepted: true,
      lngAllergy: true, liverDisease: true, currentlyPregnant: true, breastfeeding: true,
    };
    const html = renderToStaticMarkup(
      <EmergencyIntakeForm draft={draft} service={readyService} busy={null} onDraftChange={() => {}} onSubmit={async () => {}} />,
    );
    expect(html).toContain('レボノルゲストレルを含む薬でアレルギー症状が出たことがある');
    expect(html).toContain('肝臓病の診断を受けている');
    expect(html).toContain('授乳中');
    expect(html).not.toContain('女性');
    expect(html).not.toMatch(/性交|妊娠|緊急避妊/);
  });

  it('shows caution alternatives once a flag is checked without disabling submission', () => {
    const flagged = renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={{ ...completeDraft, consentAccepted: true, lngAllergy: true }}
        service={readyService} busy={null} onDraftChange={() => {}} onSubmit={async () => {}}
      />,
    );
    expect(flagged).toContain('産婦人科');
    expect(flagged).not.toMatch(/<button type="submit" disabled=""/);

    const unflagged = renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={{ ...completeDraft, consentAccepted: true }}
        service={readyService} busy={null} onDraftChange={() => {}} onSubmit={async () => {}}
      />,
    );
    expect(unflagged).not.toContain('産婦人科');
  });

  it('shows a dosing deadline preview computed client-side from the event time', () => {
    const draft = { ...completeDraft, consentAccepted: true, intercourseAt: '2026-08-18T10:00' };
    const html = renderToStaticMarkup(
      <EmergencyIntakeForm draft={draft} service={readyService} busy={null} onDraftChange={() => {}} onSubmit={async () => {}} />,
    );
    expect(html).toMatch(/服用期限[:：].*残り約\d+時間/);
  });

  it('disables slot options that end after the dosing deadline', () => {
    const lateService: EmergencyServiceOverview = {
      ...readyService,
      slots: [
        { id: 'slot-ok', starts_at: '2026-08-18T11:00:00+09:00', ends_at: '2026-08-18T11:30:00+09:00', remaining: 1 },
        { id: 'slot-late', starts_at: '2026-08-22T09:00:00+09:00', ends_at: '2026-08-22T09:30:00+09:00', remaining: 1 },
      ],
    };
    const draft = { ...completeDraft, consentAccepted: true, intercourseAt: '2026-08-18T10:00', slotId: 'slot-ok' };
    const html = renderToStaticMarkup(
      <EmergencyIntakeForm draft={draft} service={lateService} busy={null} onDraftChange={() => {}} onSubmit={async () => {}} />,
    );
    expect(html).toContain('期限超過');
    expect(html).toMatch(/<option[^>]*value="slot-late"[^>]*disabled=""/);
    expect(html).not.toMatch(/<option[^>]*value="slot-ok"[^>]*disabled=""/);
  });

  it('shows the D2 reassurance helper text next to the recent purchase count', () => {
    const html = renderToStaticMarkup(
      <EmergencyIntakeForm
        draft={{ ...completeDraft, consentAccepted: true }}
        service={readyService} busy={null} onDraftChange={() => {}} onSubmit={async () => {}}
      />,
    );
    expect(html).toContain('回数によって受付をお断りするものではありません。安全のための確認です。');
  });

  it('sends the new flags to the create API and shows the support center link unconditionally', () => {
    const source = readFileSync(new URL('./EmergencyContraceptionPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('lngAllergy: draft.lngAllergy');
    expect(source).toContain('liverDisease: draft.liverDisease');
    expect(source).toContain('currentlyPregnant: draft.currentlyPregnant');
    expect(source).toContain('breastfeeding: draft.breastfeeding');
    expect(source).toContain('相談窓口を見る');
    expect(source).toContain('support_center_url');
  });
});
