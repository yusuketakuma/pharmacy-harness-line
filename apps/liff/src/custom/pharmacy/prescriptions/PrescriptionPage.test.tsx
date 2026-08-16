import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PrescriptionPage, {
  canSubmitPrescription,
  validatePrescriptionImages,
} from './PrescriptionPage.js';

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

  it('renders mobile labels, native controls, and an initially disabled submit', () => {
    const html = renderToStaticMarkup(<PrescriptionPage />);
    expect(html).toContain('処方せんを事前送信');
    expect(html).toContain('accept="image/jpeg,image/png"');
    expect(html).toContain('処方せん原本を持参します');
    expect(html).toContain('準備完了通知をLINEで受け取ります');
    expect(html).toContain('disabled=""');
  });
});
