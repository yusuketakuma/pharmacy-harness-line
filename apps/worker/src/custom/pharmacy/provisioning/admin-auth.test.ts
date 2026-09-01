import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { adminAuth } from '../../../routes/admin/admin-auth.js';
import {
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
} from './credentials.js';

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

afterEach(() => vi.useRealTimers());

const auditEvents: Array<{ action: string; detail: string | null }> = [];

type TestSession = {
  tenantId: string;
  staffId: string;
  credentialVersion: number;
  kind: 'bootstrap' | 'standard';
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt?: string | null;
};

function tenantDb(
  seedSessions: Array<[string, TestSession]> = [],
  rejectLogout = false,
  rejectThrottle = false,
): D1Database {
  const sessions = new Map(seedSessions);
  const throttles = new Map<string, {
    failureCount: number;
    windowStartedAt: string;
    nextAllowedAt: string;
    lockedUntil: string | null;
  }>();
  let lastChanges = 0;
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          if (sql.includes('INSERT INTO admin_login_throttles')) {
            if (rejectThrottle) throw new Error('throttle unavailable');
            const key = values.slice(0, 3).join('\0');
            const now = String(values[3]);
            const cutoff = String(values[6]);
            const current = throttles.get(key);
            if (current && ((current.lockedUntil && current.lockedUntil > now) ||
                current.nextAllowedAt > now)) return null;
            const reset = !current || current.lockedUntil !== null ||
              current.windowStartedAt <= cutoff;
            const failureCount = reset ? 1 : current.failureCount + 1;
            const nextAllowedAt = reset ? now
              : String(values[current.failureCount === 1 ? 9
                : current.failureCount === 2 ? 10
                  : current.failureCount === 3 ? 11 : 12]);
            const lockedUntil = !reset && current.failureCount >= 4 ? String(values[14]) : null;
            throttles.set(key, {
              failureCount,
              windowStartedAt: reset ? now : current.windowStartedAt,
              nextAllowedAt,
              lockedUntil,
            });
            return { failure_count: failureCount, locked_until: lockedUntil };
          }
          if (sql.includes('SELECT 1 AS present FROM tenant_admin_sessions')) {
            const session = sessions.get(String(values[0]));
            return session && session.tenantId === values[1] && session.staffId === values[2] &&
              session.credentialVersion === Number(values[3]) && !session.revokedAt &&
              session.expiresAt > String(values[4])
              ? { present: 1 }
              : null;
          }
          if (sql.includes('FROM tenant_admin_sessions AS session')) {
            const session = sessions.get(String(values[0]));
            if (!session || session.revokedAt || session.expiresAt <= String(values[1]) ||
                session.tenantId !== tenant.id || session.staffId !== credential.staff_id ||
                session.credentialVersion !== credential.credential_version) return null;
            if (sql.includes('session.last_seen_at') && session.lastSeenAt &&
                session.lastSeenAt <= String(session.kind === 'bootstrap' ? values[2] : values[3])) {
              return null;
            }
            return {
              ...tenant,
              ...credential,
              session_kind: session.kind,
              last_seen_at: session.lastSeenAt ?? null,
            };
          }
          if (sql.includes('FROM tenant_admin_credentials')) {
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
        async all() {
          if (sql.includes('FROM tenant_admin_sessions')) {
            return {
              results: [...sessions.entries()]
                .filter(([, session]) =>
                  session.tenantId === values[1] &&
                  session.staffId === values[2] &&
                  !session.revokedAt &&
                  session.expiresAt > String(values[3]) &&
                  (!sql.includes('credential_version = ?') ||
                    session.credentialVersion === Number(values[4])))
                .map(([tokenHash, session]) => ({
                  session_kind: session.kind,
                  expires_at: session.expiresAt,
                  created_at: session.createdAt,
                  is_current: tokenHash === values[0] ? 1 : 0,
                })),
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('DELETE FROM admin_login_throttles')) {
            const changes = throttles.delete(values.slice(0, 3).join('\0')) ? 1 : 0;
            return { meta: { changes } };
          }
          if (sql.includes('SET last_seen_at = ?')) {
            const session = sessions.get(String(values[1]));
            if (!session || session.revokedAt) return { meta: { changes: 0 } };
            session.lastSeenAt = String(values[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO tenant_admin_audit_events')) {
            if (sql.includes('changes() > 0') && lastChanges === 0) {
              return { meta: { changes: 0 } };
            }
            auditEvents.push(sql.includes("'staff.password_changed'")
              ? { action: 'staff.password_changed', detail: null }
              : sql.includes("'staff.other_sessions_revoked'")
                ? { action: 'staff.other_sessions_revoked', detail: null }
                : { action: String(values[4]), detail: values[7] as string | null });
            lastChanges = 1;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO tenant_admin_sessions')) {
            const kind = sql.includes("'standard'") ? 'standard' : values[4] as 'bootstrap' | 'standard';
            const expiresAt = sql.includes("'standard'") ? String(values[4]) : String(values[5]);
            const hasActivity = sql.includes('last_seen_at');
            sessions.set(String(values[0]), {
              tenantId: String(values[1]),
              staffId: String(values[2]),
              credentialVersion: Number(values[3]),
              kind,
              expiresAt,
              revokedAt: null,
              createdAt: sql.includes("'standard'")
                ? String(values[hasActivity ? 6 : 5])
                : String(values[hasActivity ? 7 : 6]),
              lastSeenAt: hasActivity
                ? String(values[sql.includes("'standard'") ? 5 : 6])
                : null,
            });
            lastChanges = 1;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE tenant_admin_sessions')) {
            if (rejectLogout && sql.includes('WHERE token_hash')) {
              throw new Error('session revoke failed');
            }
            let changes = 0;
            if (sql.includes('token_hash != ?')) {
              for (const [tokenHash, session] of sessions) {
                if (session.tenantId === values[1] && session.staffId === values[2] &&
                    tokenHash !== values[3] && !session.revokedAt &&
                    session.expiresAt > String(values[4]) &&
                    (!sql.includes('credential_version <= ?') ||
                      session.credentialVersion <= Number(values[5]))) {
                  session.revokedAt = String(values[0]);
                  changes += 1;
                }
              }
            } else if (sql.includes('WHERE token_hash')) {
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
            lastChanges = changes;
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
            lastChanges = 1;
            return { meta: { changes: 1 }, now };
          }
          lastChanges = 0;
          return { meta: { changes: 0 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
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
  it('rejects browser login from unknown and LIFF origins without issuing a session', async () => {
    const testEnv = env(undefined, { LIFF_ORIGIN: 'https://liff.example.test' });
    for (const origin of ['https://evil.example.test', testEnv.LIFF_ORIGIN!]) {
      const response = await app().request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: origin },
        body: JSON.stringify({
          pharmacyCode: tenant.tenant_code,
          loginId: credential.login_id,
          password: 'Temporary pass 42',
        }),
      }, testEnv);

      expect(response.status).toBe(403);
      expect(cookieValue(response, 'lh_admin_session')).toBe('');
    }
  });

  it('allows browser login from the configured admin origin', async () => {
    const testEnv = env();
    const response = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: testEnv.ADMIN_ORIGIN! },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);

    expect(response.status).toBe(200);
  });

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
    expect(sessionCookie).toContain('Max-Age=1800');
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

  it('keeps the fifth failed password attempt locked in D1 across later requests', async () => {
    vi.useFakeTimers();
    credential.must_change_password = 0;
    const testEnv = env();
    const base = Date.parse('2026-09-01T12:00:00.000Z');
    const login = (password: string) => app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password,
      }),
    }, testEnv);

    for (const seconds of [0, 0, 1, 3, 7]) {
      vi.setSystemTime(new Date(base + seconds * 1000));
      expect((await login('Wrong password 42')).status).toBe(401);
    }
    vi.setSystemTime(new Date(base + 8_000));
    expect((await login('Temporary pass 42')).status).toBe(401);
    vi.setSystemTime(new Date(base + 907_000));
    expect((await login('Temporary pass 42')).status).toBe(200);
    expect((await login('Temporary pass 42')).status).toBe(200);
  });

  it('fails closed without a session when durable throttle state is unavailable', async () => {
    const response = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, env(tenantDb([], false, true)));

    expect(response.status).toBe(503);
    expect(cookieValue(response, 'lh_admin_session')).toBe('');
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
    expect(login.headers.get('cache-control')).toBe('no-store, private');
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
    expect(restored.headers.get('cache-control')).toBe('no-store, private');
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

    const common = await app().request('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: oldCookie,
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({
        currentPassword: 'Temporary pass 42',
        newPassword: 'passwordpassword',
      }),
    }, testEnv);
    expect(common.status).toBe(400);
    await expect(common.json()).resolves.toMatchObject({ error: expect.stringMatching(/compromised/) });
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
    expect(cookies(changed).find((value) => value.startsWith('lh_admin_session=')) ?? '')
      .toContain('Max-Age=28800');
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

  it('rejects an idle standard session and enrolls a legacy session on first use', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    credential.must_change_password = 0;
    const idleToken = generateTenantAdminSessionToken();
    const legacyToken = generateTenantAdminSessionToken();
    const future = '2026-09-01T20:00:00.000Z';
    const idleSession: TestSession = {
      tenantId: tenant.id,
      staffId: credential.staff_id,
      credentialVersion: 1,
      kind: 'standard',
      expiresAt: future,
      revokedAt: null,
      createdAt: '2026-09-01T11:00:00.000Z',
      lastSeenAt: '2026-09-01T11:44:59.000Z',
    };
    const legacySession: TestSession = {
      ...idleSession,
      createdAt: '2026-09-01T11:59:00.000Z',
      lastSeenAt: null,
    };
    const testEnv = env(tenantDb([
      [await hashTenantAdminSessionToken(idleToken), idleSession],
      [await hashTenantAdminSessionToken(legacyToken), legacySession],
    ]));
    const cookie = (token: string) => `lh_admin_session=${token}; lh_tenant=${tenant.id}`;

    expect((await app().request('/api/protected', {
      headers: { cookie: cookie(idleToken) },
    }, testEnv)).status).toBe(401);
    expect((await app().request('/api/protected', {
      headers: { cookie: cookie(legacyToken) },
    }, testEnv)).status).toBe(200);
    expect(legacySession.lastSeenAt).toBe('2026-09-01T12:00:00.000Z');
    vi.useRealTimers();
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

  it('clears cookies but does not report success when logout revocation fails', async () => {
    credential.must_change_password = 0;
    const testEnv = env(tenantDb([], true));
    const login = await app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);

    const logout = await app().request('/api/auth/logout', {
      method: 'POST',
      headers: { cookie: cookieHeader(login) },
    }, testEnv);

    expect(logout.status).toBe(503);
    expect(cookies(logout).some((value) => value.startsWith('lh_admin_session=;'))).toBe(true);
  });

  it('lists active sessions and re-authenticates before revoking every other session', async () => {
    credential.must_change_password = 0;
    const testEnv = env();
    const login = () => app().request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pharmacyCode: tenant.tenant_code,
        loginId: credential.login_id,
        password: 'Temporary pass 42',
      }),
    }, testEnv);
    const first = await login();
    const second = await login();
    const currentCookie = cookieHeader(second);
    const csrf = (await second.clone().json() as { csrfToken: string }).csrfToken;

    const listed = await app().request('/api/auth/sessions', {
      headers: { cookie: currentCookie },
    }, testEnv);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      success: true,
      data: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ current: true, sessionKind: 'standard' }),
          expect.objectContaining({ current: false, sessionKind: 'standard' }),
        ]),
      },
    });

    const denied = await app().request('/api/auth/sessions/revoke-others', {
      method: 'POST',
      headers: {
        cookie: currentCookie,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ currentPassword: 'Wrong password 42' }),
    }, testEnv);
    expect(denied.status).toBe(403);

    const revoked = await app().request('/api/auth/sessions/revoke-others', {
      method: 'POST',
      headers: {
        cookie: currentCookie,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ currentPassword: 'Temporary pass 42' }),
    }, testEnv);
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({
      success: true,
      data: { revoked: 1 },
    });
    expect(auditEvents).toEqual([{ action: 'staff.other_sessions_revoked', detail: null }]);
    const repeated = await app().request('/api/auth/sessions/revoke-others', {
      method: 'POST',
      headers: {
        cookie: currentCookie,
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ currentPassword: 'Temporary pass 42' }),
    }, testEnv);
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({ success: true, data: { revoked: 0 } });
    expect(auditEvents).toEqual([{ action: 'staff.other_sessions_revoked', detail: null }]);
    expect((await app().request('/api/protected', {
      headers: { cookie: cookieHeader(first) },
    }, testEnv)).status).toBe(401);
    expect((await app().request('/api/protected', {
      headers: { cookie: currentCookie },
    }, testEnv)).status).toBe(200);
  });

  it('lists only the current credential version and never revokes a later version', async () => {
    credential.must_change_password = 0;
    credential.credential_version = 2;
    const currentToken = generateTenantAdminSessionToken();
    const staleToken = generateTenantAdminSessionToken();
    const laterToken = generateTenantAdminSessionToken();
    const future = '2099-01-01T00:00:00.000Z';
    const session = (credentialVersion: number, createdAt: string): TestSession => ({
      tenantId: tenant.id,
      staffId: credential.staff_id,
      credentialVersion,
      kind: 'standard',
      expiresAt: future,
      revokedAt: null,
      createdAt,
    });
    const testEnv = env(tenantDb([
      [await hashTenantAdminSessionToken(staleToken), session(1, '2026-08-30T00:00:00.000Z')],
      [await hashTenantAdminSessionToken(currentToken), session(2, '2026-08-30T00:01:00.000Z')],
      [await hashTenantAdminSessionToken(laterToken), session(3, '2026-08-30T00:02:00.000Z')],
    ]));
    const csrf = 'version-csrf';
    const cookie = (token: string) =>
      `lh_admin_session=${token}; lh_tenant=${tenant.id}; lh_csrf=${csrf}`;

    const listed = await app().request('/api/auth/sessions', {
      headers: { cookie: cookie(currentToken) },
    }, testEnv);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { data: { sessions: unknown[] } }).data.sessions).toEqual([
      expect.objectContaining({ current: true }),
    ]);

    const revoked = await app().request('/api/auth/sessions/revoke-others', {
      method: 'POST',
      headers: {
        cookie: cookie(currentToken),
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ currentPassword: 'Temporary pass 42' }),
    }, testEnv);
    await expect(revoked.json()).resolves.toEqual({ success: true, data: { revoked: 1 } });

    credential.credential_version = 3;
    expect((await app().request('/api/protected', {
      headers: { cookie: cookie(laterToken) },
    }, testEnv)).status).toBe(200);
  });
});
