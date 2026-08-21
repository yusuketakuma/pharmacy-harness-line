import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../../index.js';
import { conversations } from './conversations.js';

describe('conversation collection tenant scope', () => {
  it('constrains list and count queries to the authenticated tenant', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async all() {
            queries.push({ sql, params: statement.params });
            return { results: [] };
          },
          async first() {
            queries.push({ sql, params: statement.params });
            return { total: 0 };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.route('/', conversations);

    const response = await app.request('/api/conversations', {}, { DB: db } as Env['Bindings']);

    expect(response.status).toBe(200);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) {
      expect(query.sql).toContain('tenant_line_accounts');
      expect(query.params).toContain('tenant-a');
    }
  });
});
