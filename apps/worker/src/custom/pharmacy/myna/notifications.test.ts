import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCredential: vi.fn(),
  send: vi.fn(),
  betaBinding: vi.fn(),
}));
vi.mock('../provisioning/line-credential-store.js', () => ({
  readLineCredential: mocks.readCredential,
}));
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));
vi.mock('../beta-membership/repository.js', () => ({
  getPharmacyBetaNotificationBinding: mocks.betaBinding,
}));

import {
  processExpiredMynaHandoffNotifications,
  sendMynaHandoffStatusNotification,
} from './notifications.js';

const baseHandoff = {
  id: 'handoff-a',
  line_account_id: 'account-a',
  friend_id: 'friend-a',
  patient_id: 'patient-a',
  status: 'EXPIRED',
} as const;

// 08:15 JST — inside the sending window.
const now = new Date('2026-08-20T23:15:00.000Z');

function fakeDb(handoffs: unknown[], recipient: unknown = { line_user_id: 'U-a', tenant_id: 'tenant-a' }) {
  return {
    prepare: vi.fn(() => ({
      bind: () => ({
        all: async () => ({ results: handoffs }),
        first: async () => recipient,
      }),
    })),
  } as unknown as D1Database;
}

const options = {
  proxyBaseUrl: 'https://worker.test',
  lineCredentialKey: 'key',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCredential.mockResolvedValue('token');
  mocks.send.mockResolvedValue('sent');
  mocks.betaBinding.mockResolvedValue('membership-a');
});

describe('sendMynaHandoffStatusNotification', () => {
  it('sends the approved status push with a deterministic retry key', async () => {
    const result = await sendMynaHandoffStatusNotification(
      fakeDb([]), options, baseHandoff,
    );
    expect(result).toBe('sent');
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'myna_handoff_status_v1',
      vars: { handoffStatus: 'EXPIRED' },
      retryKey: 'myna-status:handoff-a:EXPIRED',
      to: 'U-a',
      betaMembershipId: 'membership-a',
    }));
  });

  it('skips statuses that are not notified', async () => {
    const result = await sendMynaHandoffStatusNotification(
      fakeDb([]), options, { ...baseHandoff, status: 'WAITING' as never },
    );
    expect(result).toBe('skipped');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips when the friend has no LINE user id or the credential is missing', async () => {
    mocks.readCredential.mockResolvedValue(null);
    const noUser = await sendMynaHandoffStatusNotification(
      fakeDb([], { line_user_id: null, tenant_id: 'tenant-a' }), options, baseHandoff,
    );
    const noToken = await sendMynaHandoffStatusNotification(
      fakeDb([]), options, baseHandoff,
    );
    expect(noUser).toBe('skipped');
    expect(noToken).toBe('skipped');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('processExpiredMynaHandoffNotifications', () => {
  it('sends one push per expired handoff inside the sending window', async () => {
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb([baseHandoff, { ...baseHandoff, id: 'handoff-b' }]),
      { ...options, now },
    );
    expect(result).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('defers everything during JST quiet hours', async () => {
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb([baseHandoff]),
      { ...options, now: new Date('2026-08-20T14:00:00.000Z') }, // 23:00 JST
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('counts send failures without PHI in the result', async () => {
    mocks.send.mockRejectedValue(new Error('provider down'));
    const result = await processExpiredMynaHandoffNotifications(
      fakeDb([baseHandoff]), { ...options, now },
    );
    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0 });
  });
});
