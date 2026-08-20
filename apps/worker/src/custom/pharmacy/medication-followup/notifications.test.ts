import { beforeEach, describe, expect, it, vi } from 'vitest';

const listDue = vi.hoisted(() => vi.fn());
const transition = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const readCredential = vi.hoisted(() => vi.fn());

vi.mock('./repository.js', () => ({
  listDueMedicationFollowUps: listDue,
  transitionMedicationFollowUp: transition,
}));
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: send }));
vi.mock('../provisioning/line-credential-store.js', () => ({ readLineCredential: readCredential }));

import { processDueMedicationFollowUps } from './notifications.js';

const scheduled = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  line_account_id: 'account-a',
  owner_friend_id: 'friend-a',
  patient_id: 'patient-a',
  source_submission_id: 'submission-a',
  status: 'scheduled',
  due_at: '2026-08-18T00:00:00.000Z',
  delivered_at: null,
  responded_at: null,
  assigned_to: null,
  closed_at: null,
  version: 1,
  created_by: 'staff-a',
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
  line_user_id: 'U-a',
  tenant_id: 'tenant-a',
  liff_id: '2000000000-AbCdEfGh',
};

beforeEach(() => {
  vi.clearAllMocks();
  listDue.mockResolvedValue([scheduled]);
  transition
    .mockResolvedValueOnce({ ...scheduled, status: 'due', version: 2 })
    .mockResolvedValueOnce({ ...scheduled, status: 'delivered', version: 3 });
  send.mockResolvedValue('sent');
  readCredential.mockResolvedValue('token-a');
});

describe('medication follow-up notifications', () => {
  it('moves a due item through the approved PHI-free push once', async () => {
    const db = {} as D1Database;
    await expect(processDueMedicationFollowUps(db, {
      proxyBaseUrl: 'https://worker.example',
      lineCredentialKey: 'synthetic-line-credential-root-key-v1',
      now: new Date('2026-08-18T00:00:00.000Z'),
    })).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      db,
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageId: 'medication_followup_v1',
      category: 'followup_care',
      vars: { followUpId: scheduled.id, liffId: scheduled.liff_id },
      retryKey: `medication-followup:${scheduled.id}`,
    }));
    expect(transition).toHaveBeenNthCalledWith(1, db, expect.objectContaining({
      toStatus: 'due', expectedVersion: 1, actorType: 'system',
    }));
    expect(transition).toHaveBeenNthCalledWith(2, db, expect.objectContaining({
      toStatus: 'delivered', expectedVersion: 2, actorType: 'system',
    }));
  });

  it('leaves a failed delivery due for an idempotent retry', async () => {
    send.mockRejectedValue(new Error('temporary LINE failure'));
    await expect(processDueMedicationFollowUps({} as D1Database, {
      proxyBaseUrl: 'https://worker.example',
      lineCredentialKey: 'synthetic-line-credential-root-key-v1',
      now: new Date('2026-08-18T00:00:00.000Z'),
    })).resolves.toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(transition).toHaveBeenCalledTimes(1);
  });

  it('does not send when the tenant credential is missing or cross-tenant', async () => {
    readCredential.mockResolvedValue(null);
    const db = {} as D1Database;

    await expect(processDueMedicationFollowUps(db, {
      proxyBaseUrl: 'https://worker.example',
      lineCredentialKey: 'synthetic-line-credential-root-key-v1',
      now: new Date('2026-08-18T00:00:00.000Z'),
    })).resolves.toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledTimes(1);
    expect(readCredential).toHaveBeenCalledWith(db, 'synthetic-line-credential-root-key-v1', {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
    });
  });
});
