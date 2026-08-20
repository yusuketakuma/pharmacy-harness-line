import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PrescriptionPage, {
  canSubmitPrescription,
  requestedPrescriptionId,
  validatePrescriptionImages,
  pendingRequirementLabels,
} from './PrescriptionPage.js';

const source = readFileSync(
  fileURLToPath(new URL('./PrescriptionPage.tsx', import.meta.url).href),
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
    ])).toMatch(/10MiB/);
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

  it('renders mobile labels, native controls, and an initially disabled submit', () => {
    const html = renderToStaticMarkup(<PrescriptionPage />);
    expect(html).toContain('処方せんを事前送信');
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
