import { describe, expect, it } from 'vitest';
import {
  assertPharmacyAutomatedText,
  buildApprovedPharmacyMessage,
  isApprovedRenderedPharmacyMessage,
} from './policy.js';

describe('pharmacy notification policy', () => {
  it('renders only approved PHI-free templates', () => {
    expect(buildApprovedPharmacyMessage('pharmacy_onboarding_v1')).toEqual({
      type: 'text',
      text: expect.stringContaining('処方せん'),
    });
    expect(() => buildApprovedPharmacyMessage('unknown' as never)).toThrow(/unknown/);
  });

  it('rejects clinical or free-form payloads at the final fence', () => {
    expect(() => assertPharmacyAutomatedText('薬剤名: ロキソニン')).toThrow(/rejected/);
    expect(() => assertPharmacyAutomatedText('糖尿病について確認します')).toThrow(/rejected/);
    expect(() => assertPharmacyAutomatedText('さくら病院から届きました')).toThrow(/rejected/);
    expect(() => assertPharmacyAutomatedText('x'.repeat(501))).toThrow(/rejected/);
  });

  it('bounds template variables', () => {
    expect(() => buildApprovedPharmacyMessage('prescription_validity_reminder_v1', {
      genericDate: 'x'.repeat(65),
    })).toThrow(/variable/);
    expect(() => buildApprovedPharmacyMessage('prescription_validity_reminder_v1', {
      genericDate: '期限は近日中',
    })).toThrow(/variable/);
    expect(() => buildApprovedPharmacyMessage('prescription_status_v1', {
      freeText: '任意本文',
    } as never)).toThrow(/variable/);
    expect(() => buildApprovedPharmacyMessage('prescription_status_v1', {
      status: 'unknown',
    } as never)).toThrow(/variable/);
  });

  it('recognizes only rendered payloads belonging to the claimed message id', () => {
    const onboarding = buildApprovedPharmacyMessage('pharmacy_onboarding_v1');
    expect(isApprovedRenderedPharmacyMessage('pharmacy_onboarding_v1', onboarding)).toBe(true);
    expect(isApprovedRenderedPharmacyMessage('pharmacy_onboarding_v1', {
      type: 'text', text: `${onboarding.type === 'text' ? onboarding.text : ''}追記`,
    })).toBe(false);
    expect(isApprovedRenderedPharmacyMessage('prescription_validity_reminder_v1', {
      type: 'text', text: '処方せんの使用期限が近づいています。2026-08-20までに薬局へご相談ください。',
    })).toBe(true);
  });
});
