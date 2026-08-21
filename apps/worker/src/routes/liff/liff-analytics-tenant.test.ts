import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

vi.mock('../../middleware/tenant-boundary.js', () => ({
  accountResourceOwnedByStaff: vi.fn(async () => true),
}));

const { liffRoutes, resolveXHarnessToken } = await import('./liff.js');

type Query = { sql: string; params: unknown[] };

function setup(tenantId: string | null = 'tenant-a') {
  const queries: Query[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() { queries.push({ sql, params: statement.params }); return { count: 0 }; },
        async all() { queries.push({ sql, params: statement.params }); return { results: [] }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenantId', tenantId);
    await next();
  });
  app.route('/', liffRoutes);
  return { app, env: { DB: db } as Env['Bindings'], queries };
}

describe('attribution analytics tenant scope', () => {
  it.each(['/api/analytics/ref-summary', '/api/analytics/ref/abc'])('%s joins tenant_line_accounts', async (path) => {
    const { app, env, queries } = setup();
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(200);
    const friendQueries = queries.filter((q) => /FROM friends/i.test(q.sql));
    expect(friendQueries.length).toBeGreaterThan(0);
    for (const query of friendQueries) {
      expect(query.sql).toContain('tenant_line_accounts');
      expect(query.params).toContain('tenant-a');
    }
  });

  it('scopes the entry_routes name lookup to the tenant', async () => {
    const { app, env, queries } = setup();
    expect((await app.request('/api/analytics/ref/abc', {}, env)).status).toBe(200);
    const routeQueries = queries.filter((q) => /FROM entry_routes/i.test(q.sql));
    expect(routeQueries.length).toBeGreaterThan(0);
    for (const query of routeQueries) {
      expect(query.sql).toContain('tenant_line_accounts');
      expect(query.params).toContain('tenant-a');
    }
  });

  it('requires tenant context', async () => {
    const { app, env } = setup(null);
    expect((await app.request('/api/analytics/ref-summary', {}, env)).status).toBe(401);
  });
});

describe('xh token resolution', () => {
  it('never forwards a malformed token to X Harness', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"success":true,"data":{"xUsername":"a"}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const env = { X_HARNESS_URL: 'https://xh.example.test' };
      expect(await resolveXHarnessToken('../admin?x=', env)).toBeNull();
      expect(await resolveXHarnessToken('short', env)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await resolveXHarnessToken('abcDEF123_-xyz', env))?.xUsername).toBe('a');
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://xh.example.test/api/tokens/abcDEF123_-xyz/resolve');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
