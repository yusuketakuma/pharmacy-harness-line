import { describe, expect, it } from 'vitest';
import {
  signPharmacyRichMenuResumeConfirmation,
  signPharmacyRichMenuPublishConfirmation,
  verifyPharmacyRichMenuResumeConfirmation,
  verifyPharmacyRichMenuPublishConfirmation,
} from './publish-confirmation.js';

const payload = {
  tenantId: 'tenant-a', accountId: 'account-a', groupId: 'group-a',
  confirmationId: 'confirmation-1',
  evidenceDigest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
};

describe('pharmacy rich-menu publish confirmation', () => {
  it('round-trips a signed bounded evidence token', async () => {
    const token = await signPharmacyRichMenuPublishConfirmation('secret-value', payload);
    expect(token).toMatch(/^prmp1\./);
    await expect(verifyPharmacyRichMenuPublishConfirmation('secret-value', token)).resolves.toEqual(payload);
  });

  it('rejects tampering, another secret, and expiry', async () => {
    const token = await signPharmacyRichMenuPublishConfirmation('secret-value', payload);
    await expect(verifyPharmacyRichMenuPublishConfirmation('other-secret', token)).resolves.toBeNull();
    await expect(verifyPharmacyRichMenuPublishConfirmation('secret-value', `${token}x`)).resolves.toBeNull();
    const expired = await signPharmacyRichMenuPublishConfirmation('secret-value', {
      ...payload, expiresAt: Date.now() - 1,
    });
    await expect(verifyPharmacyRichMenuPublishConfirmation('secret-value', expired)).resolves.toBeNull();
    await expect(signPharmacyRichMenuPublishConfirmation('secret-value', {
      ...payload, confirmationId: '',
    })).rejects.toThrow(/invalid/i);
  });
});

describe('pharmacy rich-menu publish resume confirmation', () => {
  const resumePayload = {
    tenantId: 'tenant-a', accountId: 'account-a', groupId: 'group-a',
    operationId: 'operation-a', confirmationId: 'resume-confirmation-1',
    publishPhase: 'remote_created' as const,
    evidenceDigest: 'b'.repeat(64), expiresAt: Date.now() + 60_000,
  };

  it('binds one resume approval to the exact operation phase and evidence', async () => {
    const token = await signPharmacyRichMenuResumeConfirmation('secret-value', resumePayload);
    expect(token).toMatch(/^prmr1\./);
    await expect(verifyPharmacyRichMenuResumeConfirmation('secret-value', token))
      .resolves.toEqual(resumePayload);
    await expect(verifyPharmacyRichMenuResumeConfirmation('other-secret', token)).resolves.toBeNull();
    await expect(signPharmacyRichMenuResumeConfirmation('secret-value', {
      ...resumePayload, publishPhase: 'committed' as never,
    })).rejects.toThrow(/invalid/i);
  });
});
