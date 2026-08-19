import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../index.js';
import { accountSettings } from './account-settings.js';

function mount(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/', accountSettings);
  return { app, env: { DB: db } as Env['Bindings'] };
}

describe('account test-recipient scope', () => {
  it('reads recipient profiles from the selected LINE account only', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) { statement.params = params; return statement; },
          async first() { return { value: JSON.stringify(['friend-a', 'friend-b']) }; },
          async all() {
            queries.push({ sql, params: statement.params });
            return { results: [] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request(
      '/api/account-settings/test-recipients?accountId=account-a',
      {},
      env,
    );

    expect(response.status).toBe(200);
    expect(queries[0]?.sql).toContain('line_account_id = ?');
    expect(queries[0]?.params[0]).toBe('account-a');
  });

  it('rejects recipients that do not belong to the selected LINE account', async () => {
    const writes: string[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() { return { count: 1 }; },
          async run() { writes.push(sql); return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    } as unknown as D1Database;
    const { app, env } = mount(db);

    const response = await app.request('/api/account-settings/test-recipients', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-a', friendIds: ['friend-a', 'friend-b'] }),
    }, env);

    expect(response.status).toBe(403);
    expect(writes).toEqual([]);
  });
});
