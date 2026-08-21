import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PrescriptionPage, {
  canSubmitPrescription,
  canLaunchMynaPatientHandoff,
  initialPrescriptionView,
  mynaPatientReportOptions,
  requestedPrescriptionId,
  validatePrescriptionImages,
  pendingRequirementLabels,
  mynaStatusLabel,
  prescriptionUnmetReasons,
} from './PrescriptionPage.js';

const source = readFileSync(
  fileURLToPath(new URL('./PrescriptionPage.tsx', import.meta.url).href),
  'utf8',
);
const appSource = readFileSync(
  fileURLToPath(new URL('../../../App.tsx', import.meta.url).href),
  'utf8',
);

describe('prescription upload UI contract', () => {
  it('requires 1-4 images, both consents, and an idle request', () => {
    expect(canSubmitPrescription(0, true, true, false)).toBe(false);
    expect(canSubmitPrescription(5, true, true, false)).toBe(false);
    expect(canSubmitPrescription(1, false, true, false)).toBe(false);
    expect(canSubmitPrescription(1, true, false, false)).toBe(false);
    expect(canSubmitPrescription(1, true, true, true)).toBe(false);
    expect(canSubmitPrescription(4, true, true, false)).toBe(true);
  });

  it('rejects unsupported or oversized local files before upload', () => {
    expect(validatePrescriptionImages([
      { type: 'image/gif', size: 10 },
    ])).toMatch(/JPEGまたはPNG/);
    expect(validatePrescriptionImages([
      { type: 'image/png', size: 10 * 1024 * 1024 + 1 },
    ])).toMatch(/10MB/);
  });

  it('adds later camera selections instead of replacing earlier pages', () => {
    expect(source).toContain('setFiles((current) =>');
    expect(source).toContain('const next = [...current, ...Array.from(selected)]');
    expect(source).toContain('validatePrescriptionImages(next)');
  });

  it('accepts only an opaque submission id from a notification deep link', () => {
    expect(requestedPrescriptionId('?page=prescription&submissionId=submission-1')).toBe('submission-1');
    expect(requestedPrescriptionId('?submissionId=patient%20name')).toBeNull();
    expect(requestedPrescriptionId('')).toBeNull();
  });

  it('allows only direct send, electronic, and history views', () => {
    expect(initialPrescriptionView('?view=history')).toBe('history');
    expect(initialPrescriptionView('?view=electronic')).toBe('electronic');
    expect(initialPrescriptionView('?view=send')).toBe('send');
    expect(initialPrescriptionView('?view=admin')).toBe('send');
    expect(initialPrescriptionView('')).toBe('send');
  });

  it('routes every tab change back through the feature gate', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/prescriptions?view=send']}><PrescriptionPage /></MemoryRouter>,
    );
    expect(html).toContain('href="/prescriptions?view=send"');
    expect(html).toContain('href="/prescriptions?view=electronic"');
    expect(html).toContain('href="/prescriptions?view=history"');
    expect(appSource).toContain('<PharmacyPage screenTitle={screenTitle} capability={capability} allowExisting={allowExisting}>');
  });

  it('reuses Myna handoffs for start, resume, patient report, cancel, and paper fallback', () => {
    expect(source).toContain('mynaApi.active()');
    expect(source).toMatch(/mynaApi\.create\(\s*'E_PRESCRIPTION'/)
    expect(source).toContain('mynaApi.launch(');
    expect(source).toContain('mynaApi.report(mynaHandoff.id, result)');
    expect(source).toContain('MYNA_PATIENT_REPORT_OPTIONS');
    expect(source).toContain('reportElectronic(result)');
    expect(source).toContain('薬局での受領確認はまだ完了していません');
  });

  it('shows only transitions allowed by the current Myna patient state', () => {
    expect(canLaunchMynaPatientHandoff('CREATED')).toBe(true);
    expect(canLaunchMynaPatientHandoff('LAUNCH_REQUESTED')).toBe(true);
    expect(canLaunchMynaPatientHandoff('PATIENT_REPORTED_COMPLETE')).toBe(false);
    expect(mynaPatientReportOptions('CREATED').map(([result]) => result)).toEqual([
      'COMPLETED', 'NO_PRESCRIPTION_FOUND', 'FAILED', 'SWITCH_TO_PAPER',
    ]);
    expect(mynaPatientReportOptions('PATIENT_REPORTED_COMPLETE').map(([result]) => result))
      .toEqual(['SWITCH_TO_PAPER']);
    expect(mynaPatientReportOptions('CLOSED')).toEqual([]);
  });

  it('renders mobile labels, native controls, and an initially disabled submit', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/prescriptions?view=send']}><PrescriptionPage /></MemoryRouter>,
    );
    expect(html).toContain('処方せん受付');
    expect(html).toContain('accept="image/jpeg,image/png"');
    expect(html).toContain('処方せん原本を持参します');
    expect(html).toContain('準備完了通知をLINEで受け取ります');
    expect(html).toContain('disabled=""');
  });

  it('does not pre-check consent checkboxes when starting a resubmission', () => {
    // The checkboxes are controlled solely by originalConsent/noticeConsent
    // state, so proving startResubmission never forces that state to true
    // (and that no other code path does) guarantees they render unchecked
    // on the resubmission flow — the patient must actively re-confirm.
    const resubmission = source.slice(source.indexOf('async function startResubmission'));
    expect(resubmission).not.toMatch(/setOriginalConsent\(true\)/);
    expect(resubmission).not.toMatch(/setNoticeConsent\(true\)/);
    expect(source).not.toMatch(/setOriginalConsent\(true\)/);
    expect(source).not.toMatch(/setNoticeConsent\(true\)/);
    expect(source).toContain('checked={originalConsent}');
    expect(source).toContain('checked={noticeConsent}');
  });

  it('shows a re-confirmation hint next to the consent checkboxes during resubmission', () => {
    expect(source).toMatch(/\{replacement\s*&&\s*<p[^>]*>[^<]*再度[^<]*<\/p>\}/);
  });

  it('keeps submission blocked until both consents are re-checked, even with images attached', () => {
    // Mirrors the resubmission flow's initial state: files selected (patient
    // re-photographed), but consent checkboxes freshly unchecked.
    expect(canSubmitPrescription(2, false, false, false)).toBe(false);
    expect(canSubmitPrescription(2, true, false, false)).toBe(false);
    expect(canSubmitPrescription(2, false, true, false)).toBe(false);
    expect(canSubmitPrescription(2, true, true, false)).toBe(true);
  });

  it('sends the current pickup request and consent confirmations on final submit', () => {
    expect(source).toContain('desiredPickupAt: desiredPickupAt ? new Date(desiredPickupAt).toISOString() : null');
    expect(source).toContain('originalPrescriptionConsent: originalConsent');
    expect(source).toContain('readinessNoticeConsent: noticeConsent');
    expect(source).toContain('desiredFulfillmentMethod');
    expect(source).toContain('薬局で受け取る');
    expect(source).toContain('配送を希望');
  });

  it('shows the pharmacy preparation estimate and safe pending checks', () => {
    expect(pendingRequirementLabels(JSON.stringify([
      { code: 'stock_check', status: 'pending' },
      { code: 'original_required', status: 'satisfied' },
      { code: 'unknown_internal_code', status: 'pending' },
    ]))).toEqual(['在庫を確認しています', '薬局から確認があります']);
    expect(pendingRequirementLabels('invalid')).toEqual([]);
    expect(source).toContain('item.estimated_ready_at');
    expect(source).toContain('pendingRequirementLabels(item.requirements_json)');
    expect(source).toContain('受付状況');
  });

  it('offers a confirmed serialized arrival notice for accepted or ready prescriptions', () => {
    expect(source).toContain("item.status === 'accepted' || item.status === 'ready'");
    expect(source).toContain('来局しました');
    expect(source).toContain('prescriptionApi.arrive(item.id, item.updated_at)');
    expect(source).toContain('window.confirm(');
  });
});

describe('prescription quick wins (WP-11)', () => {
  it('uses menu-matching tab labels and plain 処方せん wording', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/prescriptions?view=send']}><PrescriptionPage /></MemoryRouter>,
    );
    expect(html).toContain('処方せんを送る');
    expect(html).toContain('電子処方箋');
    expect(html).toContain('受付状況');
    expect(html).not.toContain('紙を送信');
    expect(html).not.toContain('送信履歴');
    expect(source).toContain('処方せんが見つからなかった');
  });

  it('shows Japanese Myna status labels and a safe fallback for unknown states', () => {
    expect(mynaStatusLabel('CREATED')).toBe('手続き開始前');
    expect(mynaStatusLabel('PATIENT_REPORTED_COMPLETE')).toBe('完了を申告済み（薬局確認待ち）');
    expect(mynaStatusLabel('SOME_FUTURE_STATE')).toBe('手続き中');
    expect(source).not.toContain('状態: {mynaHandoff.status}');
  });

  it('gives the cancel action a tappable bordered button with plain wording', () => {
    expect(source).toMatch(/onClick=\{\(\) => void cancel\(item\)\} className="min-h-11[^"]*border[^"]*"[^>]*>送信を取り消す</);
  });

  it('limits pickup time to the future and shows the requested time in history', () => {
    expect(source).toMatch(/type="datetime-local"[^>]*min=\{/);
    expect(source).toContain('item.desired_pickup_at');
    expect(source).toContain('希望受取');
  });
});

describe('prescription submit flow (WP-12)', () => {
  it('lists every unmet requirement in plain Japanese', () => {
    expect(prescriptionUnmetReasons({
      imageCount: 0, originalConsent: false, noticeConsent: false, patientSelected: false, intakeDone: false,
    })).toEqual([
      '患者を選んでください',
      '患者アンケートに回答してください',
      '処方せんの写真を1枚以上選んでください',
      '「処方せん原本を持参します」にチェックしてください',
      '「準備完了通知をLINEで受け取ります」にチェックしてください',
    ]);
    expect(prescriptionUnmetReasons({
      imageCount: 5, originalConsent: true, noticeConsent: true, patientSelected: true, intakeDone: true,
    })).toEqual(['処方せんの写真は4枚までにしてください']);
    expect(prescriptionUnmetReasons({
      imageCount: 2, originalConsent: true, noticeConsent: true, patientSelected: true, intakeDone: true,
    })).toEqual([]);
  });

  it('shows the unmet list next to the submit button and focuses errors', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/prescriptions?view=send']}><PrescriptionPage /></MemoryRouter>,
    );
    expect(html).toContain('送信するには');
    expect(html).toContain('処方せんの写真を1枚以上選んでください');
    expect(source).toContain('errorRef.current?.focus()');
  });

  it('asks for confirmation before sending and shows next steps after success', () => {
    expect(source).toContain('送信内容の確認');
    expect(source).toContain('この内容で送信する');
    expect(source).toContain('修正する');
    expect(source).toContain("setConfirming(true)");
    expect(source).toContain('window.scrollTo(0, 0)');
    expect(source).toContain('次にすること');
  });
});
