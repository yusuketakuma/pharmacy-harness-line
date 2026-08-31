import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getLineAccounts: vi.fn(),
  createAccountHealthLog: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);

import { checkAccountHealth } from './ban-monitor.js';

describe('account health cron tenant boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dbMocks.getLineAccounts.mockReset();
    dbMocks.createAccountHealthLog.mockReset().mockResolvedValue(undefined);
  });

  it('derives the volume warning from each LINE account only', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([
      { id: 'account-a', channel_access_token: 'token-a', is_active: 1 },
      { id: 'account-b', channel_access_token: 'token-b', is_active: 1 },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            queries.push({ sql, values });
            return { count: values[0] === 'account-a' ? 5001 : 0 };
          },
        }),
      }),
    } as unknown as D1Database;

    await checkAccountHealth(db);

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).toContain('line_account_id = ?');
    }
    expect(queries.map(({ values }) => values[0])).toEqual(['account-a', 'account-b']);
    expect(dbMocks.createAccountHealthLog).toHaveBeenNthCalledWith(1, db, expect.objectContaining({
      lineAccountId: 'account-a',
      riskLevel: 'warning',
    }));
    expect(dbMocks.createAccountHealthLog).toHaveBeenNthCalledWith(2, db, expect.objectContaining({
      lineAccountId: 'account-b',
      riskLevel: 'normal',
    }));
  });
});
