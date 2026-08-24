import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { tenantProvisioningRoutes } from './routes.js';

type Statement = {
  sql: string;
  values: unknown[];
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
};

function fakeDb() {
  const batches: Statement[][] = [];
  return {
    db: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement: Statement = {
          sql,
          values,
          first: async <T>() => {
            if (sql.includes('FROM platform_admin_credentials AS credential')) {
              return {
                staff_id: 'platform-admin-1',
                name: 'Platform Owner',
              } as T;
            }
            if (sql.includes('FROM tenant_admin_credentials AS credential')) {
              return {
                staff_id: 'owner-1',
                credential_version: 4,
              } as T;
            }
            if (sql.includes('FROM pharmacy_cli_break_glass_sessions AS cli')) {
              return {
                token_hash: 'a'.repeat(64),
                platform_admin_id: 'platform-admin-1',
              } as T;
            }
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
        return {
          bind(...bound: unknown[]) {
            values = bound;
            statement.values = bound;
            return statement;
          },
          first: statement.first,
          run: statement.run,
        };
      },
      async batch(statements: Statement[]) {
        batches.push(statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
    batches,
  };
}

function bindings(db: D1Database): Env['Bindings'] {
  return {
    DB: db,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    PLATFORM_ADMIN_KEY: 'platform-key',
    API_KEY: 'tenant-key',
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-key',
    LINE_CREDENTIAL_KEY_V1: 'line-credential-root-key-for-tests-v1',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-access-token',
    LINE_CHANNEL_SECRET: 'line-channel-secret',
  } as Env['Bindings'];
}

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', tenantProvisioningRoutes);
  return instance;
}

const issueBody = {
  platformAdminLoginId: 'platform-owner',
  reason: 'Production rich-menu recovery',
  ticketReference: 'INC-2026-08-24',
};

describe('CLI break-glass sessions', () => {
  it('issues an audited all-operation tenant-owner session for exactly 120 minutes', async () => {
    const fake = fakeDb();
    const before = Date.now();
    const response = await app().request('/api/platform/pharmacy/tenants/tenant-a/cli-sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key', 'content-type': 'application/json' },
      body: JSON.stringify(issueBody),
    }, bindings(fake.db));
    const after = Date.now();

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    const body = await response.json() as {
      data: { sessionId: string; sessionToken: string; csrfToken: string; expiresAt: string; operationScope: string };
    };
    expect(body.data).toMatchObject({ operationScope: 'all' });
    expect(body.data.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(body.data.sessionToken).toMatch(/^tas_[A-Za-z0-9_-]{43}$/u);
    expect(body.data.csrfToken).toMatch(/^[0-9a-f-]{36}$/u);
    const expiry = Date.parse(body.data.expiresAt);
    expect(expiry).toBeGreaterThanOrEqual(before + 120 * 60_000);
    expect(expiry).toBeLessThanOrEqual(after + 120 * 60_000);

    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0].map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO tenant_admin_sessions'),
      expect.stringContaining('INSERT INTO pharmacy_cli_break_glass_sessions'),
      expect.stringContaining('INSERT INTO platform_admin_access_events'),
    ]));
    const storedValues = fake.batches[0].flatMap(({ values }) => values);
    expect(storedValues).not.toContain(body.data.sessionToken);
    expect(storedValues).toContain('all');
  });

  it('fails closed for a browser origin, wrong key, or incomplete audit reason', async () => {
    const fake = fakeDb();
    const endpoint = '/api/platform/pharmacy/tenants/tenant-a/cli-sessions';
    const browser = await app().request(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer platform-key',
        origin: 'https://admin.example.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify(issueBody),
    }, bindings(fake.db));
    const wrongKey = await app().request(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify(issueBody),
    }, bindings(fake.db));
    const noReason = await app().request(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key', 'content-type': 'application/json' },
      body: JSON.stringify({ ...issueBody, reason: '' }),
    }, bindings(fake.db));

    expect(browser.status).toBe(403);
    expect(wrongKey.status).toBe(401);
    expect(noReason.status).toBe(400);
    expect(fake.batches).toHaveLength(0);
  });

  it('revokes both the tenant session and its CLI grant with an audit event', async () => {
    const fake = fakeDb();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const response = await app().request(
      `/api/platform/pharmacy/tenants/tenant-a/cli-sessions/${sessionId}/revoke`,
      { method: 'POST', headers: { authorization: 'Bearer platform-key' } },
      bindings(fake.db),
    );

    expect(response.status).toBe(200);
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0].map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('UPDATE tenant_admin_sessions'),
      expect.stringContaining('UPDATE pharmacy_cli_break_glass_sessions'),
      expect.stringContaining('INSERT INTO platform_admin_access_events'),
    ]));
  });
});
