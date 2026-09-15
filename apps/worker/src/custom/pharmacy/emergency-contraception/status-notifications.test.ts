import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCredential: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../provisioning/line-credential-store.js', () => ({
  readLineCredential: mocks.readCredential,
}));
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));

import { processEmergencyIntakeStatusNotifications } from './status-notifications.js';

const baseRow = {
  event_id: 'event-a',
  intake_status: 'reviewed',
  tenant_id: 'tenant-a',
  line_account_id: 'account-a',
  friend_id: 'friend-a',
  line_user_id: 'U-a',
  is_following: 1,
  control_state: 'active',
  feature_enabled: 1,
  capability_enabled: 1,
  account_active: 1,
  tenant_status: 'active',
  safe_contact_mode: 'neutral_line',
};

// 08:15 JST — inside the sending window.
const now = new Date('2026-08-20T23:15:00.000Z');

function fakeDb(rows: unknown[]) {
  return {
    prepare: vi.fn(() => ({
      bind: () => ({ all: async () => ({ results: rows }) }),
    })),
  } as unknown as D1Database;
}

const options = {
  proxyBaseUrl: 'https://worker.test',
  lineCredentialKey: 'key',
  now,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCredential.mockResolvedValue('token');
  mocks.send.mockResolvedValue('sent');
});

describe('processEmergencyIntakeStatusNotifications', () => {
  it('sends a neutral push for a notified transition event', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([baseRow]), options,
    );
    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'emergency_intake_status_v1',
      vars: { intakeStatus: 'reviewed' },
      retryKey: 'emergency-intake-status:event-a',
      to: 'U-a',
    }));
  });

  it('skips intakes that did not consent to LINE contact', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([{ ...baseRow, safe_contact_mode: 'no_notification' }]), options,
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips when reminder controls or the feature are disabled', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([
        { ...baseRow, event_id: 'e1', control_state: 'frozen' },
        { ...baseRow, event_id: 'e2', feature_enabled: 0 },
        { ...baseRow, event_id: 'e3', capability_enabled: 0 },
      ]), options,
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 3 });
  });

  it('defers everything during JST quiet hours', async () => {
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([baseRow]),
      { ...options, now: new Date('2026-08-20T14:00:00.000Z') }, // 23:00 JST
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips when the friend unfollowed or the credential is missing', async () => {
    mocks.readCredential.mockResolvedValue(null);
    const result = await processEmergencyIntakeStatusNotifications(
      fakeDb([{ ...baseRow, is_following: 0 }, baseRow]), options,
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 2 });
  });
});
