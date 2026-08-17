import { describe, expect, it } from 'vitest';
import { getGrowthDashboard, savePrescriptionValidity, summarizePromiseMetrics } from './repository.js';

describe('growth loop promise metrics', () => {
  it('uses the latest quote revision created before ready and reports p50/p90 lateness', () => {
    const result = summarizePromiseMetrics([
      { submission_id: 's-1', revision: 1, estimated_ready_at: '2026-08-01T10:00:00.000Z', quote_created_at: '2026-08-01T09:00:00.000Z', ready_at: '2026-08-01T10:05:00.000Z' },
      { submission_id: 's-1', revision: 2, estimated_ready_at: '2026-08-01T10:20:00.000Z', quote_created_at: '2026-08-01T10:10:00.000Z', ready_at: '2026-08-01T10:05:00.000Z' },
      { submission_id: 's-2', revision: 1, estimated_ready_at: '2026-08-01T11:00:00.000Z', quote_created_at: '2026-08-01T10:30:00.000Z', ready_at: '2026-08-01T11:30:00.000Z' },
      { submission_id: 's-3', revision: 1, estimated_ready_at: '2026-08-01T12:00:00.000Z', quote_created_at: '2026-08-01T11:00:00.000Z', ready_at: null },
    ], 0);
    expect(result).toMatchObject({ promised: 2, onTime: 0, late: 2, p50LatenessMinutes: 17.5, p90LatenessMinutes: 27.5, promiseRevisionCount: 3, promiseWithoutReady: 1 });
  });
});

describe('prescription validity', () => {
  it('derives the inclusive four-day default when the pharmacist has verified the issue date', async () => {
    const calls: Array<{ values: unknown[] }> = [];
    const db = {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => { calls.push({ values }); return { meta: { changes: 1 } }; },
          first: async () => ({ line_account_id: 'account-a' }),
        }),
      }),
    } as unknown as D1Database;
    await savePrescriptionValidity(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', issuedOn: '2026-08-01',
      validUntil: null, validityBasis: 'default_4_days', verificationStatus: 'verified', staffId: 'staff-a',
    });
    expect(calls[0].values[3]).toBe('2026-08-04');
  });

  it('rejects a non-calendar date even when it matches the YYYY-MM-DD shape', async () => {
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) } as unknown as D1Database;
    await expect(savePrescriptionValidity(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', issuedOn: '2026-02-30',
      validUntil: null, validityBasis: 'default_4_days', verificationStatus: 'unverified', staffId: null,
    })).rejects.toThrow('invalid issued date');
  });
});

describe('growth dashboard', () => {
  it('keeps unknown source counts and SLA denominators account-scoped', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => {
            if (sql.includes('FROM pharmacy_growth_events')) return { results: [
              { event_type: 'first_follow', subject_key: 'friend-a', occurred_at: '2026-07-01T00:00:00.000Z' },
              { event_type: 'first_submission', subject_key: 'friend-a', occurred_at: '2026-07-02T00:00:00.000Z' },
            ] };
            if (sql.includes('pharmacy_submission_sources')) return { results: [{ classification: 'unknown', count: 1 }] };
            if (sql.includes('pharmacy_fulfillment_quotes')) return { results: [{ submission_id: 'submission-a', revision: 1, estimated_ready_at: '2026-08-01T10:00:00.000Z', quote_created_at: '2026-08-01T09:00:00.000Z', ready_at: '2026-08-01T10:05:00.000Z' }] };
            if (sql.includes('pharmacy_notification_events') && sql.includes('GROUP BY')) return { results: [{ category: 'transactional_care', outcome: 'sent', count: 1 }] };
            return { results: [] };
          },
          first: async () => {
            if (sql.includes('COUNT(DISTINCT e.submission_id)')) return { count: 1 };
            if (sql.includes('pharmacy_prescription_validities')) return { verified_validity: 1, reminder_sent: 0, reminder_closed_in_time: 0, expired_review_required: 0 };
            if (sql.includes('exposed_friends')) return { exposed_friends: 1, unfollow_24h: 0, unfollow_72h: 0 };
            return null;
          },
        }),
      }),
    } as unknown as D1Database;
    const dashboard = await getGrowthDashboard(db, 'account-a', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(dashboard).toMatchObject({
      sources: { primary: 0, other: 0, unknown: 1 },
      promises: { promised: 1, late: 1, readyEvents: 1 },
      unfollow: { exposedFriends: 1 },
    });
  });
});
