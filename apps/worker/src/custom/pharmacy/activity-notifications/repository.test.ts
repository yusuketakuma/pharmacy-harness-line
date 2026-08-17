import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgeActivityNotification,
  assertStaffInPharmacyAccount,
  claimActivityNotification,
  createActivityNotification,
} from './repository.js';

function fakeDb(options: {
  firstRows?: unknown[];
  runChanges?: number[];
} = {}): {
  db: D1Database;
  calls: Array<{ sql: string; values: unknown[]; operation: string }>;
  batches: Array<Array<{ sql: string; values: unknown[] }>>;
} {
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = [];
  const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
  const firstRows = [...(options.firstRows ?? [])];
  const runChanges = [...(options.runChanges ?? [1])];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      const bound = {
        sql,
        values,
        first: async () => {
          calls.push({ sql, values, operation: 'first' });
          return firstRows.shift() ?? null;
        },
        all: async () => {
          calls.push({ sql, values, operation: 'all' });
          return { results: [] };
        },
        run: async () => {
          calls.push({ sql, values, operation: 'run' });
          return { success: true, meta: { changes: runChanges.shift() ?? 1 } };
        },
      };
      return bound;
    },
  }));
  const batch = vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
    batches.push(statements.map(({ sql, values }) => ({ sql, values })));
    return statements.map(() => ({ success: true, meta: { changes: runChanges.shift() ?? 1 } }));
  });
  return { db: { prepare, batch } as unknown as D1Database, calls, batches };
}

describe('pharmacy activity notification repository', () => {
  it('checks active account membership before allowing a recipient', async () => {
    const { db, calls } = fakeDb({ firstRows: [{ ok: 1 }] });
    await expect(assertStaffInPharmacyAccount(db, 'account-1', 'staff-1')).resolves.toBeUndefined();
    expect(calls[0].sql).toContain('is_active = 1');
    expect(calls[0].values).toEqual(['staff-1', 'account-1']);
  });

  it('rejects idempotency reuse for a different activity type', async () => {
    const { db } = fakeDb({
      runChanges: [0],
      firstRows: [{
        id: 'notification-1', activity_type: 'fulfillment_quote_created',
      }],
    });
    await expect(createActivityNotification(db, {
      lineAccountId: 'account-1', staffId: 'staff-1',
      activityType: 'prescription_received', idempotencyKey: 'event-1',
    })).rejects.toThrow('idempotency conflict');
  });

  it('writes the notification and created audit in one D1 batch', async () => {
    const { db, batches } = fakeDb({
      firstRows: [{ id: 'notification-1', activity_type: 'prescription_received' }],
      runChanges: [1, 1],
    });
    await createActivityNotification(db, {
      lineAccountId: 'account-1', staffId: 'staff-1',
      activityType: 'prescription_received', idempotencyKey: 'event-1',
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][1].sql).toContain("event_type = 'created'");
  });

  it('fails a claim when the recipient row is already acknowledged', async () => {
    const { db } = fakeDb({
      runChanges: [0],
      firstRows: [{ id: 'notification-1', status: 'acknowledged', claimed_by: 'staff-1' }],
    });
    await expect(claimActivityNotification(
      db, 'account-1', 'notification-1', 'staff-1', new Date('2026-08-18T00:00:00Z'),
    )).rejects.toThrow('claim conflict');
  });

  it('fails acknowledgement until the same recipient has claimed the row', async () => {
    const { db } = fakeDb({
      runChanges: [0],
      firstRows: [{ id: 'notification-1', status: 'unread', claimed_by: null }],
    });
    await expect(acknowledgeActivityNotification(
      db, 'account-1', 'notification-1', 'staff-1', new Date('2026-08-18T00:00:00Z'),
    )).rejects.toThrow('acknowledgement conflict');
  });
});
