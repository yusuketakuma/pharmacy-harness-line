import { describe, expect, it } from 'vitest';
import { assertPharmacyAutomatedText, buildApprovedPharmacyMessage } from './policy.js';

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
});
