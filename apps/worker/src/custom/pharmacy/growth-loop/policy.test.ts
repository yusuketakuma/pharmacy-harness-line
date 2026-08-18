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
    expect(isApprovedRenderedPharmacyMessage('pharmacy_onboarding_v1', {
      ...onboarding,
      quickReply: { items: [] },
    } as never)).toBe(false);
  });

  it('keeps intake-specific status text and opaque resubmission links approved', () => {
    const ready = buildApprovedPharmacyMessage('prescription_status_v1', {
      status: 'ready', intakeMethod: 'E_PRESCRIPTION',
    });
    expect(ready).toEqual({
      type: 'text',
      text: 'お薬の準備ができました。ご案内した受取方法でお受け取りください。',
    });
    expect(isApprovedRenderedPharmacyMessage('prescription_status_v1', ready)).toBe(true);

    const resubmission = buildApprovedPharmacyMessage('prescription_status_v1', {
      status: 'needs_resubmission', reasonCode: 'blurred',
      liffId: 'liff-1', submissionId: 'submission-1',
    });
    expect(resubmission).toEqual(expect.objectContaining({
      text: expect.stringContaining('https://liff.line.me/liff-1/'),
    }));
    expect(isApprovedRenderedPharmacyMessage('prescription_status_v1', resubmission)).toBe(true);
  });

  it('builds only the fixed medication follow-up choices for an opaque id', () => {
    const followUpId = '123e4567-e89b-42d3-a456-426614174000';
    const message = buildApprovedPharmacyMessage('medication_followup_v1', { followUpId });
    expect(message).toEqual({
      type: 'text',
      text: 'お薬を使い始めてからの体調はいかがですか。あてはまるものを選んでください。',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '問題なし', data: `pharmacy-followup:${followUpId}:no_issue` } },
          { type: 'action', action: { type: 'postback', label: '気になることがある', data: `pharmacy-followup:${followUpId}:concern` } },
          { type: 'action', action: { type: 'postback', label: '薬剤師に相談したい', data: `pharmacy-followup:${followUpId}:pharmacist_requested` } },
        ],
      },
    });
    expect(isApprovedRenderedPharmacyMessage('medication_followup_v1', message)).toBe(true);
    expect(isApprovedRenderedPharmacyMessage('medication_followup_v1', {
      ...message,
      quickReply: { items: [] },
    } as never)).toBe(false);
    expect(() => buildApprovedPharmacyMessage('medication_followup_v1', {
      followUpId: 'patient-name',
    })).toThrow(/variable rejected/);
    expect(() => buildApprovedPharmacyMessage('medication_followup_v1', {
      followUpId,
      genericDate: '2026-08-21',
    })).toThrow(/variable rejected/);
  });
});
