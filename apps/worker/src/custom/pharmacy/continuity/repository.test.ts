import { describe, expect, it, vi } from 'vitest';
import {
  completeContinuityAfterClose,
  linkContinuitySubmission,
  listContinuityObligations,
  openContinuityObligation,
  pausePatientContinuity,
} from './repository.js';

function fakeDb(firstRows: unknown[] = [], allRows: unknown[] = []): {
  db: D1Database;
  calls: Array<{ sql: string; values: unknown[]; operation: string }>;
} {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const rows = [...firstRows];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      sql,
      values,
      first: async () => {
        calls.push({ sql, values, operation: 'first' });
        return rows.shift() ?? null;
      },
      all: async () => {
        calls.push({ sql, values, operation: 'all' });
        return { results: allRows };
      },
      run: async () => {
        calls.push({ sql, values, operation: 'run' });
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const batch = vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
    calls.push(...statements.map(({ sql, values }) => ({ sql, values, operation: 'batch' })));
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  });
  return { db: { prepare, batch } as unknown as D1Database, calls };
}

const source = {
  patient_id: 'patient-1', owner_friend_id: 'friend-1',
  consent_at: '2026-08-17T00:00:00.000Z',
};

describe('continuity repository', () => {
  it('opens one account-scoped follow-up record after a closed submission', async () => {
    const obligation = { id: 'obligation-1', status: 'active', patient_id: 'patient-1' };
    const { db, calls } = fakeDb([source, obligation]);
    await expect(openContinuityObligation(db, 'account-1', 'submission-1', 'staff-1', new Date('2026-08-17T00:00:00Z'))).resolves.toMatchObject({
      id: 'obligation-1', status: 'active',
    });
    expect(calls[0].sql).toContain('pharmacy_prescription_patients');
    expect(calls.some((call) => call.sql.includes('INSERT INTO pharmacy_continuity_obligations'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('INSERT INTO pharmacy_continuity_events'))).toBe(true);
  });

  it('links the next submitted prescription to the patient follow-up record', async () => {
    const { db, calls } = fakeDb([
      { patient_id: 'patient-1', owner_friend_id: 'friend-1' },
      { id: 'obligation-1', status: 'active', patient_id: 'patient-1' },
    ]);
    await expect(linkContinuitySubmission(db, 'account-1', 'submission-2', 'friend-1', 'system')).resolves.toMatchObject({
      id: 'obligation-1', status: 'linked',
    });
    expect(calls.some((call) => call.sql.includes("SET status = 'linked'"))).toBe(true);
  });

  it('fulfills a linked record and opens the next cycle once the candidate closes', async () => {
    const { db, calls } = fakeDb([
      { id: 'obligation-1', status: 'linked', patient_id: 'patient-1', owner_friend_id: 'friend-1', source_submission_id: 'submission-1' },
      { patient_id: 'patient-1', owner_friend_id: 'friend-1', consent_at: '2026-08-17T00:00:00.000Z' },
      { id: 'obligation-2', status: 'active', patient_id: 'patient-1' },
    ]);
    await completeContinuityAfterClose(db, 'account-1', 'submission-2', 'staff-1', new Date('2026-08-17T00:00:00Z'));
    expect(calls.some((call) => call.sql.includes("SET status = 'fulfilled'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes('INSERT INTO pharmacy_continuity_obligations'))).toBe(true);
  });

  it('makes the close side effect replay-safe for the fulfilled event', async () => {
    const { db, calls } = fakeDb([
      { id: 'obligation-1', status: 'linked', patient_id: 'patient-1', owner_friend_id: 'friend-1', source_submission_id: 'submission-1' },
      { patient_id: 'patient-1', owner_friend_id: 'friend-1', consent_at: '2026-08-17T00:00:00.000Z' },
      { id: 'obligation-2', status: 'active', patient_id: 'patient-1' },
    ]);
    await completeContinuityAfterClose(db, 'account-1', 'submission-2', 'staff-1', new Date('2026-08-17T00:00:00Z'));
    const fulfilledEvent = calls.find((call) => call.sql.includes('INSERT INTO pharmacy_continuity_events') && call.sql.includes("'fulfilled'"));
    expect(fulfilledEvent?.sql).toContain('NOT EXISTS');
  });

  it('writes each state transition and its audit event in one batch', async () => {
    const link = fakeDb([
      { patient_id: 'patient-1', owner_friend_id: 'friend-1' },
      { id: 'obligation-1', status: 'active', patient_id: 'patient-1' },
    ]);
    await linkContinuitySubmission(link.db, 'account-1', 'submission-2', 'friend-1', 'system');

    const close = fakeDb([
      { id: 'obligation-1', status: 'linked', patient_id: 'patient-1', owner_friend_id: 'friend-1', source_submission_id: 'submission-1' },
      { patient_id: 'patient-1', owner_friend_id: 'friend-1', consent_at: '2026-08-17T00:00:00.000Z' },
      { id: 'obligation-2', status: 'active', patient_id: 'patient-1' },
    ]);
    await completeContinuityAfterClose(close.db, 'account-1', 'submission-2', 'staff-1', new Date('2026-08-17T00:00:00Z'));

    const pause = fakeDb();
    await pausePatientContinuity(pause.db, 'account-1', 'friend-1', 'obligation-1');

    for (const [fake, status] of [[link, 'linked'], [close, 'fulfilled'], [pause, 'paused']] as const) {
      const transition = fake.calls.find((call) => call.sql.includes(`SET status = '${status}'`));
      const event = fake.calls.find((call) =>
        call.sql.includes('INSERT INTO pharmacy_continuity_events') && call.sql.includes(`'${status}'`));
      expect(transition?.operation).toBe('batch');
      expect(event?.operation).toBe('batch');
    }
  });

  it('lists obligations without crossing the account boundary', async () => {
    const { db, calls } = fakeDb([], [{ id: 'obligation-1', status: 'active', patient_display_name: '山田 太郎' }]);
    await expect(listContinuityObligations(db, 'account-1')).resolves.toEqual([
      { id: 'obligation-1', status: 'active', patient_display_name: '山田 太郎' },
    ]);
    expect(calls[0].sql).toContain('LEFT JOIN friends f');
    expect(calls[0].sql).toContain('f.line_account_id = o.line_account_id');
    expect(calls[0].sql).toContain('o.line_account_id = ?');
    expect(calls[0].values).toEqual(['account-1']);
  });
});
