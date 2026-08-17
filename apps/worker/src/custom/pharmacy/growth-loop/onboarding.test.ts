import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  event: vi.fn(),
  push: vi.fn(),
  friend: vi.fn(),
  update: vi.fn(),
}));

vi.mock('./access.js', () => ({ hasPharmacyCapability: mocks.capability }));
vi.mock('./repository.js', () => ({ recordGrowthEvent: mocks.event }));
vi.mock('./sender.js', () => ({ sendPharmacyAutomatedPush: mocks.push }));
vi.mock('@line-crm/db', () => ({
  getFriendByLineUserIdForAccount: mocks.friend,
  updateFriendFollowStatus: mocks.update,
}));

import { recordPharmacyFollow } from './onboarding.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockResolvedValue(true);
  mocks.event.mockResolvedValue(true);
  mocks.push.mockResolvedValue(undefined);
});

describe('pharmacy onboarding activation', () => {
  it('sends the welcome once for a first follow event', async () => {
    await recordPharmacyFollow({
      db: {} as D1Database, lineAccountId: 'account-a', friendId: 'friend-a', lineUserId: 'U-a',
      firstFollowedAt: '2026-08-17T00:00:00.000Z', proxyBaseUrl: 'https://worker.example', accessToken: 'token',
    });
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'first_follow' }));
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'pharmacy_onboarding_v1' }));
  });

  it('does not resend after an idempotent redelivery', async () => {
    mocks.event.mockResolvedValue(false);
    await recordPharmacyFollow({
      db: {} as D1Database, lineAccountId: 'account-a', friendId: 'friend-a', lineUserId: 'U-a',
      firstFollowedAt: '2026-08-17T00:00:00.000Z', proxyBaseUrl: 'https://worker.example', accessToken: 'token',
    });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
