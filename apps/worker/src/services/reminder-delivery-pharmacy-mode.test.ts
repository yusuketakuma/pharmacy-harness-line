import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDue: vi.fn(),
  getFriend: vi.fn(),
  complete: vi.fn(),
  pharmacyMode: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  getDueReminderDeliveries: mocks.getDue,
  getFriendById: mocks.getFriend,
  getLineAccountById: vi.fn().mockResolvedValue(null),
  completeReminderIfDone: mocks.complete,
  jstNow: vi.fn().mockReturnValue('2026-08-18T09:00:00+09:00'),
}));
vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: mocks.pharmacyMode,
}));

import { processReminderDeliveries } from './reminder-delivery.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDue.mockResolvedValue([{
    id: 'friend-reminder-1',
    friend_id: 'friend-1',
    reminder_id: 'reminder-1',
    steps: [{ id: 'step-1', message_type: 'text', message_content: 'generic reminder' }],
  }]);
  mocks.getFriend.mockResolvedValue({
    id: 'friend-1',
    line_user_id: 'U-friend',
    line_account_id: 'account-pharmacy',
    is_following: 1,
  });
  mocks.pharmacyMode.mockResolvedValue(true);
});

describe('generic reminder exclusion for pharmacy accounts', () => {
  it('does not send or complete a due generic reminder', async () => {
    const pushMessage = vi.fn();
    await processReminderDeliveries(
      { prepare: vi.fn() } as unknown as D1Database,
      { pushMessage } as never,
    );

    expect(pushMessage).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
