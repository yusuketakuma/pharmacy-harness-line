import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { tenantProvisioningRoutes } from './routes.js';

vi.mock('@line-crm/db', () => ({ getStaffByApiKey: vi.fn(async () => null) }));

type Statement = {
  sql: string;
  values: unknown[];
  run(): Promise<{ meta: { changes: number } }>;
};

function fakeDb() {
  const batches: Statement[][] = [];
  let bootstrap: {
    bootstrap_staff_id: string;
    login_id: string;
    password_hash: string;
    must_change_password: number;
  } | null = null;
  return {
    db: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement: Statement & { first<T>(): Promise<T | null> } = {
          sql,
          values,
          first: async <T>() => {
            if (sql.includes('FROM tenants AS tenant')) {
              return (values[0] === 'tenant-a'
                ? {
                    id: 'tenant-a',
                    tenant_code: 'pharmacy-a',
                    display_name: 'Pharmacy A',
                    line_account_id: 'account-a',
                    ...bootstrap,
                  }
                : null) as T | null;
            }
            if (sql.includes('COUNT(*) AS count') && sql.includes('tenant_admin_credentials')) {
              return { count: bootstrap ? 1 : 0 } as T;
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
        const credential = statements.find(({ sql }) => sql.includes('INSERT INTO tenant_admin_credentials'));
        const marker = statements.find(({ sql }) => sql.includes('INSERT INTO pharmacy_tenant_admin_bootstraps'));
        if (credential && marker) {
          bootstrap = {
            bootstrap_staff_id: String(marker.values[1]),
            login_id: String(credential.values[2]),
            password_hash: String(credential.values[3]),
            must_change_password: 1,
          };
        }
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
    batches,
  };
}

function env(db: D1Database): Env['Bindings'] {
  return {
    DB: db,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    PLATFORM_ADMIN_KEY: 'platform-key',
    LINE_CREDENTIAL_KEY_V1: 'line-credential-root-key-for-tests-v1',
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-token-key-for-tests',
    API_KEY: 'legacy-key',
    LINE_CHANNEL_SECRET: 'default-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'default-token',
    LIFF_URL: 'https://liff.line.me/default',
    LINE_CHANNEL_ID: 'default-channel',
    LINE_LOGIN_CHANNEL_ID: 'default-login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'default-login-secret',
    WORKER_URL: 'https://api.example.test',
  };
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', tenantProvisioningRoutes);
  return instance;
}

function request(password = 'Temporary pass 42') {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer platform-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      loginId: 'admin-a',
      displayName: 'Owner A',
      email: 'owner@example.test',
      temporaryPassword: password,
    }),
  };
}

describe('existing tenant admin bootstrap', () => {
  it('issues one password owner without storing or returning the temporary password', async () => {
    const fake = fakeDb();
    const response = await app().request(
      '/api/platform/pharmacy/tenants/tenant-a/admin-bootstrap',
      request(),
      env(fake.db),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { tenantCode: 'pharmacy-a', adminLoginId: 'admin-a', replayed: false },
    });
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0].map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO staff_members'),
      expect.stringContaining('INSERT INTO tenant_staff_memberships'),
      expect.stringContaining('INSERT INTO tenant_admin_credentials'),
      expect.stringContaining('INSERT INTO pharmacy_tenant_admin_bootstraps'),
      expect.stringContaining("'tenant_admin_bootstrapped'"),
    ]));
    const assignment = fake.batches[0].find(({ sql }) => sql.includes('pharmacy_staff_accounts'));
    expect(assignment?.sql).toContain('SELECT line_account_id');
    expect(assignment?.values).toContain('tenant-a');
    const stored = fake.batches[0].flatMap(({ values }) => values);
    expect(stored).not.toContain('Temporary pass 42');
    const missing = await app().request(
      '/api/platform/pharmacy/tenants/missing/admin-bootstrap',
      request(),
      env(fake.db),
    );
    expect(JSON.stringify(await missing.json())).not.toContain('Temporary pass 42');
  });

  it('replays the same bootstrap but rejects a second first owner', async () => {
    const fake = fakeDb();
    const endpoint = '/api/platform/pharmacy/tenants/tenant-a/admin-bootstrap';
    expect((await app().request(endpoint, request(), env(fake.db))).status).toBe(201);

    const replay = await app().request(endpoint, request(), env(fake.db));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ data: { replayed: true } });
    expect(fake.batches).toHaveLength(1);

    const other = await app().request(endpoint, {
      ...request('Another temporary 84'),
      body: JSON.stringify({
        loginId: 'another-admin',
        displayName: 'Another Owner',
        temporaryPassword: 'Another temporary 84',
      }),
    }, env(fake.db));
    expect(other.status).toBe(409);
    expect(fake.batches).toHaveLength(1);
  });

  it('rejects browser and cross-tenant requests before mutation', async () => {
    const fake = fakeDb();
    const browser = await app().request(
      '/api/platform/pharmacy/tenants/tenant-a/admin-bootstrap',
      { ...request(), headers: { ...request().headers, origin: 'https://admin.example.test' } },
      env(fake.db),
    );
    const missing = await app().request(
      '/api/platform/pharmacy/tenants/tenant-b/admin-bootstrap',
      request(),
      env(fake.db),
    );

    expect(browser.status).toBe(403);
    expect(missing.status).toBe(404);
    expect(fake.batches).toHaveLength(0);
  });

  it('returns a secret-free JSON error when password hashing fails', async () => {
    const fake = fakeDb();
    const derive = vi.spyOn(crypto.subtle, 'deriveBits')
      .mockRejectedValueOnce(new Error('synthetic crypto failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app().request(
      '/api/platform/pharmacy/tenants/tenant-a/admin-bootstrap',
      request(),
      env(fake.db),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.stringify(await response.json())).not.toContain('Temporary pass 42');
    expect(log).toHaveBeenCalledWith(
      '[tenant-admin-bootstrap] password hashing failed',
      'synthetic crypto failure',
    );
    derive.mockRestore();
    log.mockRestore();
  });
});
