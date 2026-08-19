import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { hashTenantPassword } from './credentials.js';
import { tenantProvisioningRoutes } from './routes.js';

vi.mock('@line-crm/db', () => ({ getStaffByApiKey: vi.fn(async () => null) }));

type Statement = { sql: string; values: unknown[]; run(): Promise<{ meta: { changes: number } }> };

function fakeDb() {
  const inserted: Record<string, unknown[]> = {};
  let credential: { staff_id: string; login_id: string; password_hash: string; must_change_password: number } | null = null;
  return {
    get credential() { return credential; },
    inserted,
    db: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement: Statement & { first<T>(): Promise<T | null> } = {
          sql,
          values,
          first: async <T>() => (sql.includes('FROM platform_admin_credentials AS credential') &&
            credential && String(values[0]).toLowerCase() === credential.login_id.toLowerCase()
            ? credential as T
            : null),
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
        for (const statement of statements) {
          const table = /INSERT INTO (\w+)/.exec(statement.sql)?.[1];
          if (table) inserted[table] = statement.values;
        }
        const row = statements.find(({ sql }) => sql.includes('INSERT INTO platform_admin_credentials'));
        if (row) {
          credential = {
            staff_id: String(row.values[0]),
            login_id: String(row.values[1]),
            password_hash: String(row.values[2]),
            must_change_password: 1,
          };
        }
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
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

const PATH = '/api/platform/pharmacy/platform-admins';

function request(overrides: { key?: string | null; password?: string; loginId?: string } = {}) {
  const key = overrides.key === undefined ? 'platform-key' : overrides.key;
  return {
    method: 'POST',
    headers: {
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      loginId: overrides.loginId ?? 'platform-owner',
      displayName: 'Platform Owner',
      email: 'platform@example.test',
      temporaryPassword: overrides.password ?? 'Temporary pass 42',
    }),
  };
}

describe('platform admin bootstrap route', () => {
  it('creates the staff, platform_admins and credential rows with a correct PLATFORM_ADMIN_KEY', async () => {
    const store = fakeDb();
    const response = await app().request(PATH, request(), env(store.db));

    expect(response.status).toBe(201);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      success: true,
      data: { adminLoginId: 'platform-owner', replayed: false },
    });
    // The route must never echo the credential back.
    expect(body).not.toContain('Temporary pass 42');
    expect(Object.keys(store.inserted).sort())
      .toEqual(['platform_admin_credentials', 'platform_admins', 'staff_members']);
    // The staff row must never carry a usable Bearer key.
    expect(String(store.inserted.staff_members[3])).toMatch(/^disabled:/);
    expect(store.credential?.must_change_password).toBe(1);
  });

  it('rejects a missing, wrong or browser-originated platform key', async () => {
    const testEnv = env(fakeDb().db);
    expect((await app().request(PATH, request({ key: null }), testEnv)).status).toBe(401);
    expect((await app().request(PATH, request({ key: 'wrong-key' }), testEnv)).status).toBe(401);

    const fromBrowser = await app().request(PATH, {
      ...request(),
      headers: { ...request().headers, origin: 'https://admin.example.test' },
    }, testEnv);
    expect(fromBrowser.status).toBe(403);
  });

  it('is unreachable without PLATFORM_ADMIN_KEY configured', async () => {
    const response = await app().request(PATH, request(), {
      ...env(fakeDb().db),
      PLATFORM_ADMIN_KEY: undefined,
    });
    expect(response.status).toBe(503);
  });

  it('rejects invalid input and a duplicate login, but replays an identical retry', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);

    const shortPassword = await app().request(PATH, request({ password: 'short' }), testEnv);
    expect(shortPassword.status).toBe(400);

    expect((await app().request(PATH, request(), testEnv)).status).toBe(201);

    const replay = await app().request(PATH, request(), testEnv);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ data: { replayed: true } });

    const conflict = await app().request(PATH, request({ password: 'Different pass 42' }), testEnv);
    expect(conflict.status).toBe(409);
  });

  it('refuses to replay once the temporary password has been changed', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    expect((await app().request(PATH, request(), testEnv)).status).toBe(201);

    store.credential!.must_change_password = 0;
    store.credential!.password_hash = await hashTenantPassword('Permanent password 84');
    const conflict = await app().request(PATH, request(), testEnv);
    expect(conflict.status).toBe(409);
  });
});
