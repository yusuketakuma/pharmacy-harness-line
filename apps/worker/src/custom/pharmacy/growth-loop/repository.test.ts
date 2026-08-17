import { describe, expect, it } from 'vitest';
import {
  classifySubmissionSource,
  createMedicalSource,
  getGrowthDashboard,
  markPrescriptionValidityExpiredReview,
  savePharmacyCapabilityConfig,
  savePrescriptionValidity,
  setMedicalSourceActive,
  summarizeCohorts,
  summarizePromiseMetrics,
} from './repository.js';

describe('growth loop activation cohorts', () => {
  const events = [
    { event_type: 'first_follow', subject_key: 'friend:friend-a', occurred_at: '2026-08-10T00:00:00.000Z' },
    { event_type: 'first_friend_submission', subject_key: 'friend:friend-a', occurred_at: '2026-09-01T00:00:00.000Z' },
    { event_type: 'first_submission', subject_key: 'patient:patient-a', occurred_at: '2026-08-11T00:00:00.000Z' },
    { event_type: 'second_submission', subject_key: 'patient:patient-a', occurred_at: '2026-10-01T00:00:00.000Z' },
  ];

  it('separates the selected cohort month from its later observation window', () => {
    expect(summarizeCohorts(
      events,
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
    )).toMatchObject({
      measurableFollows: 1,
      firstSubmissionRate: { numerator: 1, denominator: 1, immatureCohort: 0 },
      secondSubmissionRate: { numerator: 1, denominator: 1, immatureCohort: 0 },
    });
  });

  it('keeps cohorts immature until their observation windows have elapsed', () => {
    expect(summarizeCohorts(
      events,
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
    )).toMatchObject({
      firstSubmissionRate: { denominator: 0, immatureCohort: 1 },
      secondSubmissionRate: { denominator: 0, immatureCohort: 1 },
    });
  });
});

describe('growth loop promise metrics', () => {
  it('uses the latest quote revision created before ready and reports p50/p90 lateness', () => {
    const result = summarizePromiseMetrics([
      { submission_id: 's-1', revision: 1, estimated_ready_at: '2026-08-01T10:00:00.000Z', quote_created_at: '2026-08-01T09:00:00.000Z', ready_at: '2026-08-01T10:05:00.000Z' },
      { submission_id: 's-1', revision: 2, estimated_ready_at: '2026-08-01T10:20:00.000Z', quote_created_at: '2026-08-01T10:10:00.000Z', ready_at: '2026-08-01T10:05:00.000Z' },
      { submission_id: 's-2', revision: 1, estimated_ready_at: '2026-08-01T11:00:00.000Z', quote_created_at: '2026-08-01T10:30:00.000Z', ready_at: '2026-08-01T11:30:00.000Z' },
      { submission_id: 's-2', revision: 2, estimated_ready_at: '2026-08-01T11:15:00.000Z', quote_created_at: '2026-08-01T10:45:00.000Z', ready_at: '2026-08-01T11:30:00.000Z' },
      { submission_id: 's-3', revision: 1, estimated_ready_at: '2026-08-01T12:00:00.000Z', quote_created_at: '2026-08-01T11:00:00.000Z', ready_at: null },
    ], 0);
    expect(result).toMatchObject({ promised: 2, onTime: 0, late: 2, p50LatenessMinutes: 10, p90LatenessMinutes: 14, promiseRevisionCount: 4, promiseWithoutReady: 1 });
  });
});

describe('prescription validity', () => {
  it('moves one expired validity to staff review with an atomic audit event', async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await expect(markPrescriptionValidityExpiredReview(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', localDate: '2026-08-18',
      actorId: 'system', at: new Date('2026-08-18T00:00:00.000Z'),
    })).resolves.toBe(true);

    expect(batches[0][0].sql).toContain("verification_status = 'expired_review_required'");
    expect(batches[0][0].sql).toContain('line_account_id = ?');
    expect(batches[0][1].values).toEqual(expect.arrayContaining([
      'account-a', 'prescription_validity_updated', 'submission-a', '{"actor_id":"system"}',
    ]));
  });

  it('commits the validity mutation and PHI-free audit event in one D1 batch', async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        sql,
        values,
        run: async () => ({ meta: { changes: 1 } }),
      }) }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await savePrescriptionValidity(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', issuedOn: '2026-08-01',
      validUntil: null, validityBasis: 'default_4_days', verificationStatus: 'verified', staffId: 'staff-a',
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][1].sql).toContain('INSERT INTO pharmacy_growth_events');
    expect(batches[0][1].values).toEqual(expect.arrayContaining([
      'account-a', 'prescription_validity_updated', 'submission-a', '{"actor_id":"staff-a"}',
    ]));
  });

  it('derives the inclusive four-day default when the pharmacist has verified the issue date', async () => {
    const calls: Array<{ values: unknown[] }> = [];
    const db = {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => { calls.push({ values }); return { meta: { changes: 1 } }; },
          first: async () => ({ line_account_id: 'account-a' }),
        }),
      }),
      batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(
        statements.map((statement) => statement.run()),
      ),
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

  it('requires verified dates and never accepts a conflicting default valid-until date', async () => {
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) } as unknown as D1Database;
    await expect(savePrescriptionValidity(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', issuedOn: null,
      validUntil: null, validityBasis: 'default_4_days', verificationStatus: 'verified', staffId: 'staff-a',
    })).rejects.toThrow(/verified dates/);
    await expect(savePrescriptionValidity(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', issuedOn: '2026-08-01',
      validUntil: '2026-08-05', validityBasis: 'default_4_days', verificationStatus: 'verified', staffId: 'staff-a',
    })).rejects.toThrow(/four-day/);
  });

  it('schedules the prior-day reminder for 09:00 Asia/Tokyo and resets delivery only when validity changes', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        run: async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
      }) }),
      batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(
        statements.map((statement) => statement.run()),
      ),
    } as unknown as D1Database;
    await savePrescriptionValidity(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', issuedOn: '2026-08-01',
      validUntil: '2026-08-10', validityBasis: 'prescriber_specified', verificationStatus: 'verified', staffId: 'staff-a',
    });
    expect(calls[0].values).toContain('2026-08-09T00:00:00.000Z');
    expect(calls[0].sql).toContain('reminder_sent_at = CASE');
  });
});

describe('medical source classification', () => {
  it('commits capability and source mutations with account-scoped audit events', async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        sql,
        values,
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => ({
          line_account_id: 'account-a', mode: 'pharmacy',
          capabilities_json: '["pharmacy_dashboard"]', proactive_monthly_limit: 1,
          unfollow_alert_state: 'alert_only', created_at: '2026-08-18', updated_at: '2026-08-18',
        }),
      }) }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await savePharmacyCapabilityConfig(
      db, 'account-a', ['pharmacy_dashboard'], 1, 'alert_only', 'staff-a',
    );
    await createMedicalSource(db, {
      lineAccountId: 'account-a', displayName: 'Clinic A', classification: 'primary', staffId: 'staff-a',
    });
    await setMedicalSourceActive(db, 'account-a', 'source-a', false, 'staff-a');

    expect(batches).toHaveLength(3);
    expect(batches.map((batch) => batch[1].values[2])).toEqual([
      'capability_config_updated', 'medical_source_created', 'medical_source_updated',
    ]);
    expect(batches.every((batch) => batch[1].values.includes('{"actor_id":"staff-a"}'))).toBe(true);
  });

  it('commits source classification and audit together', async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        sql,
        values,
        first: async () => ({ id: 'source-a', classification: 'primary' }),
        run: async () => ({ meta: { changes: 1 } }),
      }) }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database;

    await classifySubmissionSource(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', sourceId: 'source-a',
      classification: 'primary', staffId: 'staff-a',
    });

    expect(batches).toHaveLength(1);
    expect(batches[0][1].values).toEqual(expect.arrayContaining([
      'account-a', 'submission_source_classified', 'submission-a', '{"actor_id":"staff-a"}',
    ]));
  });

  it('changes source availability only inside its account', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        run: async () => { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
      }) }),
      batch: async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(
        statements.map((statement) => statement.run()),
      ),
    } as unknown as D1Database;

    await setMedicalSourceActive(db, 'account-a', 'source-a', false, 'staff-a');

    expect(calls[0].sql).toContain('WHERE id = ? AND line_account_id = ?');
    expect(calls[0].values).toEqual([0, expect.any(String), 'source-a', 'account-a']);
  });

  it('derives classification from the account-owned source and rejects mismatches', async () => {
    const writes: string[] = [];
    const db = {
      prepare: (sql: string) => ({ bind: () => ({
        first: async () => ({ id: 'source-a', classification: 'primary' }),
        run: async () => { writes.push(sql); return { meta: { changes: 1 } }; },
      }) }),
    } as unknown as D1Database;
    await expect(classifySubmissionSource(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', sourceId: 'source-a',
      classification: 'other', staffId: 'staff-a',
    })).rejects.toThrow(/classification mismatch/);
    expect(writes).toHaveLength(0);
  });

  it('requires unknown to have no source id', async () => {
    const db = { prepare: () => { throw new Error('D1 must not be reached'); } } as unknown as D1Database;
    await expect(classifySubmissionSource(db, {
      lineAccountId: 'account-a', submissionId: 'submission-a', sourceId: 'source-a',
      classification: 'unknown', staffId: 'staff-a',
    })).rejects.toThrow(/unknown source/);
  });
});

describe('growth dashboard', () => {
  it('keeps unknown source counts and SLA denominators account-scoped', async () => {
    const queries: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => {
            queries.push(sql);
            if (sql.includes('FROM pharmacy_growth_events')) return { results: [
              { event_type: 'first_follow', subject_key: 'friend:friend-a', occurred_at: '2026-08-01T00:00:00.000Z' },
              { event_type: 'first_friend_submission', subject_key: 'friend:friend-a', occurred_at: '2026-08-02T00:00:00.000Z' },
              { event_type: 'first_submission', subject_key: 'patient:patient-a', occurred_at: '2026-08-02T00:00:00.000Z' },
            ] };
            if (sql.includes('pharmacy_submission_sources')) return { results: [{ classification: 'unknown', count: 1 }] };
            if (sql.includes('pharmacy_fulfillment_quotes')) return { results: [{ submission_id: 'submission-a', revision: 1, estimated_ready_at: '2026-08-01T10:00:00.000Z', quote_created_at: '2026-08-01T09:00:00.000Z', ready_at: '2026-08-01T10:05:00.000Z' }] };
            if (sql.includes('pharmacy_notification_events') && sql.includes('GROUP BY')) return { results: [
              { category: 'transactional_care', outcome: 'sent', count: 1 },
              { category: 'proactive_noncare', outcome: 'sent', count: 2 },
              { category: 'proactive_noncare', outcome: 'blocked', count: 1 },
            ] };
            return { results: [] };
          },
          first: async () => {
            queries.push(sql);
            if (sql.includes('COUNT(DISTINCT e.submission_id)')) return { count: 1 };
            if (sql.includes('pharmacy_prescription_validities')) return { verified_validity: 1, reminder_sent: 0, reminder_closed_in_time: 0, expired_review_required: 0, confirmed_expired: 1 };
            if (sql.includes('exposed_friends')) return { exposed_friends: 1, unfollow_24h: 0, unfollow_72h: 0 };
            if (sql.includes('unfollow_alert_state')) return { unfollow_alert_state: 'alert_only' };
            return null;
          },
        }),
      }),
    } as unknown as D1Database;
    const dashboard = await getGrowthDashboard(db, 'account-a', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(dashboard).toMatchObject({
      sources: { primary: 0, other: 0, unknown: 1 },
      promises: { promised: 1, late: 1, readyEvents: 1 },
      validity: { confirmedExpired: 1 },
      notifications: { alertState: 'alert_only', attempted: 4, proactiveAttempts: 3, proactiveCapBlocked: 1 },
      unfollow: { exposedFriends: 1 },
    });
    expect(queries.find((sql) => sql.includes('pharmacy_submission_sources'))).toContain("accepted.event_type = 'status_changed'");
    expect(queries.find((sql) => sql.includes('pharmacy_fulfillment_quotes'))).toContain("ready.event_type = 'status_changed'");
    expect(queries.find((sql) => sql.includes('verified_validity'))).toContain('COALESCE(attr.is_synthetic, 0) = 0');
    expect(queries.find((sql) => sql.includes('exposed_friends'))).toContain("n.outcome = 'sent'");
  });
});
