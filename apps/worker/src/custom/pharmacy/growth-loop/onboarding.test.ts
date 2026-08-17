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

import { recordAcceptedSubmissionActivation, recordPharmacyFollow } from './onboarding.js';

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
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: 'first_follow', subjectKey: 'friend:friend-a',
    }));
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'pharmacy_onboarding_v1' }));
  });

  it('reuses the same sender idempotency key on redelivery so a failed first push can retry', async () => {
    mocks.event.mockResolvedValue(false);
    await recordPharmacyFollow({
      db: {} as D1Database, lineAccountId: 'account-a', friendId: 'friend-a', lineUserId: 'U-a',
      firstFollowedAt: '2026-08-17T00:00:00.000Z', proxyBaseUrl: 'https://worker.example', accessToken: 'token',
    });
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({
      retryKey: 'pharmacy-onboarding:friend-a:2026-08-17T00:00:00.000Z',
    }));
  });

  it('counts accepted submissions by linked patient instead of mixing a family under one friend', async () => {
    const sql: string[] = [];
    const db = {
      prepare(statement: string) {
        sql.push(statement);
        return {
          bind() {
            return {
              first: async () => statement.includes('COUNT(DISTINCT s.id)')
                ? { count: 2 }
                : {
                    friend_id: 'friend-a', patient_id: 'patient-child',
                    created_at: '2026-08-17T01:00:00.000Z',
                  },
            };
          },
        };
      },
    } as unknown as D1Database;

    await recordAcceptedSubmissionActivation(db, 'account-a', 'submission-2');

    expect(sql[0]).toContain('s.friend_id AS friend_id');
    expect(sql[0]).toContain("e.event_type = 'status_changed'");
    expect(sql[1]).toContain('patient_id');
    expect(mocks.event).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: 'second_submission',
      aggregateId: 'submission-2',
      subjectKey: 'patient:patient-child',
    }));
  });

  it('records friend-level first submission separately for follow conversion', async () => {
    const db = {
      prepare(statement: string) {
        return { bind() { return { first: async () => statement.includes('COUNT(DISTINCT s.id)')
          ? { count: 1 }
          : { friend_id: 'friend-a', patient_id: 'patient-child', created_at: '2026-08-17T01:00:00.000Z' } }; } };
      },
    } as unknown as D1Database;
    await recordAcceptedSubmissionActivation(db, 'account-a', 'submission-1');
    expect(mocks.event).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: 'first_friend_submission', subjectKey: 'friend:friend-a',
    }));
  });
});
