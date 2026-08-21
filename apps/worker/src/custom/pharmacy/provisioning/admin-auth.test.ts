import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { adminAuth } from '../../../routes/admin/admin-auth.js';
import { hashTenantPassword } from './credentials.js';

vi.mock('@line-crm/db', () => ({
  getStaffByApiKey: vi.fn(async () => null),
}));

const tenant = {
  id: 'tenant-a',
  tenant_code: 'pharmacy-a',
  display_name: 'Pharmacy A',
};

const credential = {
  staff_id: 'staff-a',
  name: 'Owner A',
  role: 'owner' as const,
  login_id: 'admin-a',
  password_hash: '',
  must_change_password: 1,
  credential_version: 1,
};

beforeEach(async () => {
  credential.password_hash = await hashTenantPassword('Temporary pass 42');
  credential.must_change_password = 1;
  credential.credential_version = 1;
  auditEvents.length = 0;
});

const auditEvents: Array<{ action: string; detail: string | null }> = [];

function tenantDb(): D1Database {
  const sessions = new Map<string, {
    tenantId: string;
    staffId: string;
    credentialVersion: number;
    kind: 'bootstrap' | 'standard';
    expiresAt: string;
    revokedAt: string | null;
  }>();
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          if (sql.includes('FROM tenant_admin_sessions AS session')) {
            const session = sessions.get(String(values[0]));
            if (!session || session.revokedAt || session.expiresAt <= String(values[1]) ||
                session.tenantId !== tenant.id || session.staffId !== credential.staff_id ||
                session.credentialVersion !== credential.credential_version) return null;
            return { ...tenant, ...credential, session_kind: session.kind };
          }
          if (sql.includes('FROM tenant_admin_credentials AS credential')) {
            const isLogin = sql.includes('credential.login_id');
            if (isLogin) {
              return values[0] === tenant.tenant_code && values[1] === credential.login_id
                ? { ...tenant, ...credential }
                : null;
            }
            return values[0] === tenant.id && values[1] === credential.staff_id &&
              values[2] === credential.credential_version
              ? { ...tenant, ...credential }
              : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO tenant_admin_audit_events')) {
            auditEvents.push({ action: String(values[4]), detail: values[7] as string | null });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO tenant_admin_sessions')) {
            const kind = sql.includes("'standard'") ? 'standard' : values[4] as 'bootstrap' | 'standard';
            const expiresAt = sql.includes("'standard'") ? String(values[4]) : String(values[5]);
            sessions.set(String(values[0]), {
              tenantId: String(values[1]),
              staffId: String(values[2]),
              credentialVersion: Number(values[3]),
              kind,
              expiresAt,
              revokedAt: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE tenant_admin_sessions')) {
            let changes = 0;
            if (sql.includes('WHERE token_hash')) {
              const session = sessions.get(String(values[1]));
              if (session && !session.revokedAt) {
                session.revokedAt = String(values[0]);
                changes = 1;
              }
            } else {
              for (const session of sessions.values()) {
                if (session.tenantId === values[1] && session.staffId === values[2] &&
                    !session.revokedAt && session.credentialVersion <= Number(values[3])) {
                  session.revokedAt = String(values[0]);
                  changes += 1;
                }
              }
            }
            return { meta: { changes } };
          }
          if (sql.includes('UPDATE tenant_admin_credentials')) {
            const [passwordHash, now, tenantId, staffId, version] = values;
            if (tenantId !== tenant.id || staffId !== credential.staff_id ||
                version !== credential.credential_version) {
              return { meta: { changes: 0 } };
            }
            credential.password_hash = String(passwordHash);
            credential.must_change_password = 0;
            credential.credential_version += 1;
            return { meta: { changes: 1 }, now };
          }
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return db as unknown as D1Database;
}

function env(
  db = tenantDb(),
  overrides: Partial<Env['Bindings']> = {},
): Env['Bindings'] {
  return {
    DB: db,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'legacy-api-key',
    LIFF_URL: 'https://liff.line.me/example',
    LINE_CHANNEL_ID: 'line-channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    ADMIN_ORIGIN: 'https://admin.example.test',
    ...overrides,
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-token-key-for-tests',
  };
}

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', adminAuth);
  instance.get('/api/protected', (c) => c.json({ success: true, staff: c.get('staff') }));
  instance.post('/api/protected', (c) => c.json({ success: true, staff: c.get('staff') }));
  return instance;
}

function cookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

function cookieValue(response: Response, name: string): string {
  const item = cookies(response).find((value) => value.startsWith(`${name}=`));
  const encoded = item?.split(';', 1)[0]?.slice(name.length + 1) ?? '';
  return decodeURIComponent(encoded);
}

function cookieHeader(response: Response): string {
  return cookies(response)
    .map((value) => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
}

describe('tenant admin password authentication', () => {
  it('rejects malformed login field types without throwing', async () => {
    for (const body of [
      null,
      { pharmacyCode: tenant.tenant_code, loginId: credential.login_id, password: 42 },
    ]) {
      const response = await app().request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, env());

      expect(response.status).toBe(400);
      expect(cookieValue(response, 'lh_admin_session')).toBe('');
      expect(cookieValue(response, 'lh_tenant')).toBe('');
    }
  });

  it('rejects legacy API-key browser login without issuing cookies', async () => {
    const response = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        apiKey: 'legacy-api-key',
      }),
    }, env());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Login ID and password are required',
    });
    expect(cookieValue(response, 'lh_admin_session')).toBe('');
    expect(cookieValue(response, 'lh_tenant')).toBe('');
  });

  it('issues a revocable opaque tenant session without exposing the temporary password', async () => {
    const response = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, env());

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: { tenantId: string; mustChangePassword: boolean };
    };
    expect(body.data).toMatchObject({ tenantId: tenant.id, mustChangePassword: true });
    const session = cookieValue(response, 'lh_admin_session');
    expect(session).toMatch(/^tas_[A-Za-z0-9_-]{43}$/);
    expect(session).not.toContain('Temporary pass 42');
    const sessionCookie = cookies(response).find((value) => value.startsWith('lh_admin_session=')) ?? '';
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Max-Age=604800');
    const csrfCookie = cookies(response).find((value) => value.startsWith('lh_csrf=')) ?? '';
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(csrfCookie).toContain('SameSite=Lax');
  });

  it('uses SameSite=None for an explicitly allowed cross-site admin', async () => {
    const testEnv = env(tenantDb(), {
      ADMIN_ORIGIN: 'https://pharmacy-admin.pages.dev',
      WORKER_URL: 'https://pharmacy-api.workers.dev',
      ADMIN_ALLOW_CROSS_SITE: 'true',
    });
    const response = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);

    expect(response.status).toBe(200);
    expect(cookies(response).find((value) => value.startsWith('lh_admin_session=')) ?? '')
      .toContain('SameSite=None');
  });

  it('rejects the wrong password and cross-tenant cookie selection', async () => {
    const testEnv = env();
    const wrongPassword = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Wrong password 42',
      }),
    }, testEnv);
    expect(wrongPassword.status).toBe(401);

    const login = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);
    const session = cookieValue(login, 'lh_admin_session');
    const response = await app().request('/api/protected', {
      headers: { cookie: `lh_admin_session=${encodeURIComponent(session)}; lh_tenant=tenant-b` },
    }, testEnv);
    expect(response.status).toBe(401);
  });

  it('enforces CSRF and restores an opaque password session', async () => {
    credential.must_change_password = 0;
    const testEnv = env();
    const login = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);
    const cookie = cookieHeader(login);
    const csrf = (await login.clone().json() as { csrfToken: string }).csrfToken;

    const missing = await app().request('/api/protected', {
      method: 'POST',
      headers: { cookie },
    }, testEnv);
    expect(missing.status).toBe(403);

    const mismatch = await app().request('/api/protected', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': 'wrong-token' },
    }, testEnv);
    expect(mismatch.status).toBe(403);

    const allowed = await app().request('/api/protected', {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf },
    }, testEnv);
    expect(allowed.status).toBe(200);

    const restored = await app().request('/api/auth/session', {
      headers: { cookie },
    }, testEnv);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      data: { id: credential.staff_id, tenantId: tenant.id },
      csrfToken: csrf,
    });

    const withoutCsrf = cookie
      .split('; ')
      .filter((value) => !value.startsWith('lh_csrf='))
      .join('; ');
    const refreshed = await app().request('/api/auth/session', {
      headers: { cookie: withoutCsrf },
    }, testEnv);
    expect(refreshed.status).toBe(200);
    const refreshedBody = await refreshed.json() as { csrfToken: string };
    expect(refreshedBody.csrfToken).toBeTruthy();
    expect(cookies(refreshed).find((value) => value.startsWith('lh_csrf=')) ?? '')
      .toContain(`lh_csrf=${refreshedBody.csrfToken}`);
  });

  it('forces first-login password change and invalidates the old session version', async () => {
    const testEnv = env();
    const login = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);
    const oldCookie = cookieHeader(login);
    const csrf = (await login.clone().json() as { csrfToken: string }).csrfToken;

    const blocked = await app().request('/api/protected', {
      headers: { cookie: oldCookie },
    }, testEnv);
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({ error: 'Password change required' });

    const reused = await app().request('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: oldCookie,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({
        currentPassword: 'Temporary pass 42',
        newPassword: 'Temporary pass 42',
      }),
    }, testEnv);
    expect(reused.status).toBe(400);
    expect(credential.must_change_password).toBe(1);

    const changed = await app().request('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: oldCookie,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({
        currentPassword: 'Temporary pass 42',
        newPassword: 'Permanent password 84',
      }),
    }, testEnv);
    expect(changed.status).toBe(200);
    expect(credential.must_change_password).toBe(0);
    expect(credential.credential_version).toBe(2);
    expect(auditEvents).toEqual([{ action: 'staff.password_changed', detail: null }]);

    const oldSession = await app().request('/api/protected', {
      headers: { cookie: oldCookie },
    }, testEnv);
    expect(oldSession.status).toBe(401);

    const newCookie = cookieHeader(changed);
    const allowed = await app().request('/api/protected', {
      headers: { cookie: newCookie },
    }, testEnv);
    expect(allowed.status).toBe(200);

    const logout = await app().request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: newCookie },
    }, testEnv);
    expect(logout.status).toBe(200);
    const revoked = await app().request('/api/protected', {
      headers: { cookie: newCookie },
    }, testEnv);
    expect(revoked.status).toBe(401);
  });

  it('rejects malformed password-change field types without throwing', async () => {
    const testEnv = env();
    const login = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);
    const cookie = cookieHeader(login);
    const csrf = (await login.clone().json() as { csrfToken: string }).csrfToken;

    const response = await app().request('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ currentPassword: 'Temporary pass 42', newPassword: 42 }),
    }, testEnv);

    expect(response.status).toBe(400);
    expect(credential.must_change_password).toBe(1);
  });
});
