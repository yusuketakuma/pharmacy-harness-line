import { describe, expect, it, vi } from 'vitest';
import { createActivityNotification, listActivityNotifications } from './repository.js';

describe('shared pharmacy activity repository', () => {
  it('hashes dedupe material and never selects it for the browser', async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const prepare = vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        return {
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => ({ id: 'notification-1', line_account_id: 'account-a', activity_type: 'prescription_received' }),
          all: async () => ({ results: [] }),
        };
      },
    }));
    const db = { prepare } as unknown as D1Database;
    await createActivityNotification(db, {
      lineAccountId: 'account-a', activityType: 'prescription_received', idempotencyKey: 'raw-source-id',
    });
    await listActivityNotifications(db, 'account-a', false, 20);
    const insert = statements.find((statement) => statement.sql.includes('INSERT'))!;
    expect(insert.values).not.toContain('raw-source-id');
    expect(statements.at(-1)!.sql).not.toContain('dedupe_hash');
  });
});
