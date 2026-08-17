import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn(), expire: vi.fn() }));
vi.mock('./sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));
vi.mock('./repository.js', () => ({ markPrescriptionValidityExpiredReview: mocks.expire }));
import { processDuePrescriptionValidityReminders } from './validity.js';

function fakeDb() {
  const calls: string[] = [];
  const queries: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (..._values: unknown[]) => ({
        all: async () => {
          queries.push(sql);
          if (sql.includes('v.valid_until < ?')) return { results: [] };
          return { results: [{ submission_id: 'submission-1', line_account_id: 'account-a', friend_id: 'friend-a', valid_until: '2026-08-21', line_user_id: 'U-a', channel_access_token: 'token' }] };
        },
        run: async () => {
          calls.push(sql);
          return { meta: { changes: sql.includes("SET verification_status = 'expired_review_required'") ? 0 : 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, calls, queries };
}

describe('prescription validity reminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expire.mockResolvedValue(false);
  });

  it('claims, sends, and marks a verified validity once', async () => {
    const { db, calls, queries } = fakeDb();
    mocks.send.mockResolvedValue(undefined);
    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(result.sent).toBe(1);
    expect(calls.filter((sql) => sql.includes('SET reminder_claimed_at = ?') || sql.includes('SET reminder_sent_at = ?')).length).toBe(2);
    expect(queries[1]).toContain("s.status = 'ready'");
    expect(calls.find((sql) => sql.includes('SET reminder_claimed_at = ?'))).toContain("s.status = 'ready'");
  });

  it('does not send when another cron invocation wins the claim', async () => {
    const db = {
      prepare: (sql: string) => ({ bind: () => ({
        all: async () => sql.includes('v.valid_until < ?')
          ? ({ results: [] })
          : ({ results: [{ submission_id: 'submission-1', line_account_id: 'account-a', friend_id: 'friend-a', valid_until: '2026-08-21', line_user_id: 'U-a', channel_access_token: 'token' }] }),
        run: async () => ({ meta: { changes: sql.includes('SET reminder_claimed_at = ?') ? 0 : 1 } }),
      }) }),
    } as unknown as D1Database;

    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({ sent: 0, skipped: 1 }));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('uses the Asia/Tokyo calendar date across the UTC day boundary', async () => {
    const todayFor = async (now: Date) => {
      const bound: unknown[][] = [];
      const db = {
        prepare: () => ({ bind: (...values: unknown[]) => ({
          run: async () => { bound.push(values); return { meta: { changes: 0 } }; },
          all: async () => { bound.push(values); return { results: [] }; },
        }) }),
      } as unknown as D1Database;
      await processDuePrescriptionValidityReminders(db, { proxyBaseUrl: 'https://worker.example', now });
      return [bound[0][0], bound[1][0]];
    };

    await expect(todayFor(new Date('2026-08-20T14:59:59.000Z'))).resolves.toEqual(['2026-08-20', '2026-08-20']);
    await expect(todayFor(new Date('2026-08-20T15:00:00.000Z'))).resolves.toEqual(['2026-08-21', '2026-08-21']);
  });

  it('releases the claim after a send failure so a later cron can retry', async () => {
    const calls: string[] = [];
    const db = {
      prepare: (sql: string) => ({ bind: () => ({
        all: async () => sql.includes('v.valid_until < ?')
          ? ({ results: [] })
          : ({ results: [{ submission_id: 'submission-1', line_account_id: 'account-a', friend_id: 'friend-a', valid_until: '2026-08-21', line_user_id: 'U-a', channel_access_token: 'token' }] }),
        run: async () => { calls.push(sql); return { meta: { changes: 1 } }; },
      }) }),
    } as unknown as D1Database;
    mocks.send.mockRejectedValueOnce(new Error('temporary LINE failure'));

    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({ sent: 0, failed: 1 }));
    expect(calls.some((sql) => sql.includes('SET reminder_claimed_at = NULL'))).toBe(true);
  });

  it('moves expired open submissions to staff review and never sends a late reminder', async () => {
    const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        run: async () => { calls.push({ sql, values, operation: 'run' }); return { meta: { changes: 1 } }; },
        all: async () => {
          calls.push({ sql, values, operation: 'all' });
          return sql.includes('v.valid_until < ?')
            ? { results: [{ submission_id: 'submission-1', line_account_id: 'account-a' }] }
            : { results: [] };
        },
      }) }),
    } as unknown as D1Database;
    mocks.expire.mockResolvedValueOnce(true);
    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-21T00:30:00.000Z'),
    });
    expect(result).toEqual(expect.objectContaining({ sent: 0, expiredReviewRequired: 1 }));
    expect(mocks.expire).toHaveBeenCalledWith(db, expect.objectContaining({
      lineAccountId: 'account-a', submissionId: 'submission-1', localDate: '2026-08-21', actorId: 'system',
    }));
    expect(calls.filter((call) => call.operation === 'all')[1]?.sql).toContain('v.valid_until >= ?');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
