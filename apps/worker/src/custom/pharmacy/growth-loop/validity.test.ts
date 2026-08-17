import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./sender.js', () => ({ sendPharmacyAutomatedPush: mocks.send }));
import { processDuePrescriptionValidityReminders } from './validity.js';

function fakeDb() {
  const calls: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (..._values: unknown[]) => ({
        all: async () => ({ results: [{ submission_id: 'submission-1', line_account_id: 'account-a', friend_id: 'friend-a', valid_until: '2026-08-21', line_user_id: 'U-a', channel_access_token: 'token' }] }),
        run: async () => {
          calls.push(sql);
          return { meta: { changes: sql.includes("SET verification_status = 'expired_review_required'") ? 0 : 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, calls };
}

describe('prescription validity reminders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims, sends, and marks a verified validity once', async () => {
    const { db, calls } = fakeDb();
    mocks.send.mockResolvedValue(undefined);
    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(result.sent).toBe(1);
    expect(calls.filter((sql) => sql.includes('SET reminder_claimed_at = ?') || sql.includes('SET reminder_sent_at = ?')).length).toBe(2);
  });

  it('moves expired open submissions to staff review and never sends a late reminder', async () => {
    const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        run: async () => { calls.push({ sql, values, operation: 'run' }); return { meta: { changes: 1 } }; },
        all: async () => { calls.push({ sql, values, operation: 'all' }); return { results: [] }; },
      }) }),
    } as unknown as D1Database;
    const result = await processDuePrescriptionValidityReminders(db, {
      proxyBaseUrl: 'https://worker.example',
      now: new Date('2026-08-21T00:30:00.000Z'),
    });
    expect(result).toEqual(expect.objectContaining({ sent: 0, expiredReviewRequired: 1 }));
    expect(calls[0].sql).toContain("SET verification_status = 'expired_review_required'");
    expect(calls.find((call) => call.operation === 'all')?.sql).toContain('v.valid_until >= ?');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
