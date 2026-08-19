import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { hashTenantPassword } from '../provisioning/credentials.js';
import { platformAdminAuthMiddleware } from './auth.js';
import { platformAdminRoutes } from './routes.js';

vi.mock('@line-crm/db', () => ({ getStaffByApiKey: vi.fn(async () => null) }));

const patient = {
  id: 'patient-1',
  relationship: 'self',
  name: '田中 太郎',
  archived_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

vi.mock('../intake/repository.js', () => ({
  listAdminPharmacyPatients: vi.fn(async (_db: unknown, lineAccountId: string) =>
    (lineAccountId === 'account-a' ? [patient] : [])),
  getAdminPharmacyPatientHistory: vi.fn(async (_db: unknown, lineAccountId: string, patientId: string) =>
    (lineAccountId === 'account-a' && patientId === patient.id
      ? { patient, intakes: [], latestIntake: null, prescriptions: [{ id: 'sub-1' }], quotes: [], continuity: [], medicationFollowUps: [], timeline: [] }
      : null)),
}));

vi.mock('../continuity/next-intake.js', () => ({
  listAccountExpectations: vi.fn(async () => [
    { id: 'exp-1', patient_id: 'patient-1' },
    { id: 'exp-2', patient_id: 'patient-other' },
  ]),
}));

vi.mock('../myna/repository.js', () => ({
  listMynaHandoffs: vi.fn(async () => [
    { id: 'myna-1', patient_id: 'patient-1' },
    { id: 'myna-2', patient_id: 'patient-other' },
  ]),
}));

const admin = {
  staff_id: 'staff-platform',
  name: 'Platform Owner',
  login_id: 'platform-admin',
  password_hash: '',
  must_change_password: 1,
  credential_version: 1,
  is_active: 1,
  staff_active: 1,
};

const tenants = [
  { id: 'tenant-a', tenant_code: 'pharmacy-a', display_name: 'Pharmacy A', status: 'active' },
  { id: 'tenant-b', tenant_code: 'pharmacy-b', display_name: 'Pharmacy B', status: 'suspended' },
];

type Session = {
  staffId: string;
  credentialVersion: number;
  kind: 'bootstrap' | 'standard';
  expiresAt: string;
  revokedAt: string | null;
};

type Store = {
  db: D1Database;
  auditEvents: Array<Record<string, unknown>>;
  tenants: typeof tenants;
};

function fakeDb(): Store {
  const sessions = new Map<string, Session>();
  const auditEvents: Array<Record<string, unknown>> = [];
  const rows = tenants.map((tenant) => ({ ...tenant }));
  const stats = { line_account_count: 1, staff_count: 2, patient_count: 3 };

  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          if (sql.includes('FROM platform_admin_sessions AS session')) {
            const session = sessions.get(String(values[0]));
            if (!session || session.revokedAt || session.expiresAt <= String(values[1]) ||
                !admin.is_active || !admin.staff_active ||
                session.credentialVersion !== admin.credential_version) return null;
            return { ...admin, session_kind: session.kind };
          }
          if (sql.includes('FROM platform_admin_credentials AS credential')) {
            return values[0] === admin.login_id && admin.is_active && admin.staff_active
              ? { ...admin }
              : null;
          }
          if (sql.includes('FROM platform_admin_credentials')) {
            return values[0] === admin.staff_id ? { ...admin } : null;
          }
          if (sql.includes('FROM tenants AS tenant')) {
            const found = rows.find((tenant) => tenant.id === values[0]);
            return found ? { ...found, ...stats } : null;
          }
          if (sql.includes('FROM tenants')) {
            return rows.find((tenant) => tenant.id === values[0]) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM tenants AS tenant')) {
            return { results: rows.map((tenant) => ({ ...tenant, ...stats })) };
          }
          if (sql.includes('FROM tenant_line_accounts AS mapping')) {
            return {
              results: values[0] === 'tenant-a'
                ? [{ id: 'account-a', name: 'Account A', channel_id: '1000', is_active: 1 }]
                : [],
            };
          }
          if (sql.includes('FROM tenant_line_accounts')) {
            return { results: values[0] === 'tenant-a' ? [{ line_account_id: 'account-a' }] : [] };
          }
          if (sql.includes('FROM pharmacy_prescription_events')) {
            return { results: [{ id: 'event-1', tenant_id: 'tenant-a' }] };
          }
          if (sql.includes('FROM pharmacy_webhook_event_receipts')) {
            return { results: [{ webhook_event_id: 'w-1', tenant_id: 'tenant-a' }] };
          }
          if (sql.includes('FROM platform_admin_access_events')) {
            return { results: auditEvents.slice().reverse() };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO platform_admin_sessions')) {
            // The change-password insert inlines 'standard', shifting the binds.
            const literal = sql.includes("'standard'");
            sessions.set(String(values[0]), {
              staffId: String(values[1]),
              credentialVersion: Number(values[2]),
              kind: literal ? 'standard' : values[3] as 'bootstrap' | 'standard',
              expiresAt: String(literal ? values[3] : values[4]),
              revokedAt: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO platform_admin_access_events')) {
            auditEvents.push({
              id: values[0],
              platform_admin_id: values[1],
              tenant_id: values[2],
              action: values[3],
              resource_type: values[4],
              resource_id: values[5],
              detail_json: values[6],
              created_at: values[7],
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE platform_admin_sessions')) {
            let changes = 0;
            if (sql.includes('WHERE token_hash')) {
              const session = sessions.get(String(values[1]));
              if (session && !session.revokedAt) {
                session.revokedAt = String(values[0]);
                changes = 1;
              }
            } else {
              for (const session of sessions.values()) {
                if (session.staffId === values[1] && !session.revokedAt &&
                    session.credentialVersion <= Number(values[2])) {
                  session.revokedAt = String(values[0]);
                  changes += 1;
                }
              }
            }
            return { meta: { changes } };
          }
          if (sql.includes('UPDATE platform_admin_credentials')) {
            const [passwordHash, , staffId, version] = values;
            if (staffId !== admin.staff_id || version !== admin.credential_version) {
              return { meta: { changes: 0 } };
            }
            admin.password_hash = String(passwordHash);
            admin.must_change_password = 0;
            admin.credential_version += 1;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE tenants')) {
            const target = rows.find((tenant) => tenant.id === values[3]);
            if (!target) return { meta: { changes: 0 } };
            target.display_name = String(values[0]);
            target.status = String(values[1]);
            return { meta: { changes: 1 } };
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
  return { db: db as unknown as D1Database, auditEvents, tenants: rows };
}

function env(db: D1Database, overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
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
  instance.use('/api/platform-admin/*', platformAdminAuthMiddleware);
  instance.route('/', platformAdminRoutes);
  return instance;
}

function cookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
}

function cookieValue(response: Response, name: string): string {
  const item = cookies(response).find((value) => value.startsWith(`${name}=`));
  return decodeURIComponent(item?.split(';', 1)[0]?.slice(name.length + 1) ?? '');
}

function cookieHeader(response: Response): string {
  return cookies(response)
    .map((value) => value.split(';', 1)[0])
    .filter(Boolean)
    .join('; ');
}

function loginRequest(password = 'Temporary pass 42', loginId = admin.login_id) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  };
}

/** Logs in and changes the temporary password so a standard session is available. */
async function standardSession(testEnv: Env['Bindings']) {
  const login = await app().request('/api/platform-admin/login', loginRequest(), testEnv);
  const bootstrapCookie = cookieHeader(login);
  const bootstrapCsrf = (await login.clone().json() as { csrfToken: string }).csrfToken;
  const changed = await app().request('/api/platform-admin/change-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: bootstrapCookie,
      'x-platform-admin-csrf-token': bootstrapCsrf,
    },
    body: JSON.stringify({
      currentPassword: 'Temporary pass 42',
      newPassword: 'Permanent password 84',
    }),
  }, testEnv);
  expect(changed.status).toBe(200);
  return {
    cookie: cookieHeader(changed),
    csrf: (await changed.clone().json() as { csrfToken: string }).csrfToken,
  };
}

beforeEach(async () => {
  admin.password_hash = await hashTenantPassword('Temporary pass 42');
  admin.must_change_password = 1;
  admin.credential_version = 1;
  admin.is_active = 1;
  admin.staff_active = 1;
});

describe('platform admin authentication', () => {
  it('rejects missing fields, unknown logins and wrong passwords alike', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);

    const missing = await app().request('/api/platform-admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: admin.login_id }),
    }, testEnv);
    expect(missing.status).toBe(400);

    const unknown = await app().request(
      '/api/platform-admin/login',
      loginRequest('Temporary pass 42', 'nobody'),
      testEnv,
    );
    expect(unknown.status).toBe(401);

    const wrong = await app().request(
      '/api/platform-admin/login',
      loginRequest('Wrong password 42'),
      testEnv,
    );
    expect(wrong.status).toBe(401);
    expect(cookieValue(wrong, 'lh_platform_admin_session')).toBe('');
    expect(store.auditEvents).toHaveLength(0);
  });

  it('refuses to log in when the cookie topology is misconfigured', async () => {
    const store = fakeDb();
    const response = await app().request('/api/platform-admin/login', loginRequest(), env(store.db, {
      ADMIN_ORIGIN: 'https://pharmacy-admin.pages.dev',
      WORKER_URL: 'https://pharmacy-api.workers.dev',
    }));
    expect(response.status).toBe(500);
    expect(cookieValue(response, 'lh_platform_admin_session')).toBe('');
  });

  it('rejects an inactive platform admin and an inactive staff member', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);

    admin.is_active = 0;
    expect((await app().request('/api/platform-admin/login', loginRequest(), testEnv)).status).toBe(401);

    admin.is_active = 1;
    admin.staff_active = 0;
    expect((await app().request('/api/platform-admin/login', loginRequest(), testEnv)).status).toBe(401);
  });

  it('issues a bootstrap session that only reaches session and change-password', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const login = await app().request('/api/platform-admin/login', loginRequest(), testEnv);

    expect(login.status).toBe(200);
    await expect(login.clone().json()).resolves.toMatchObject({
      success: true,
      data: { id: admin.staff_id, name: admin.name, mustChangePassword: true },
    });
    const session = cookieValue(login, 'lh_platform_admin_session');
    expect(session).toMatch(/^pas_[A-Za-z0-9_-]{43}$/);
    expect(session).not.toContain('Temporary pass 42');
    expect(store.auditEvents).toMatchObject([{ action: 'login', tenant_id: null }]);

    const cookie = cookieHeader(login);
    const blocked = await app().request('/api/platform-admin/tenants', { headers: { cookie } }, testEnv);
    expect(blocked.status).toBe(403);

    const self = await app().request('/api/platform-admin/session', { headers: { cookie } }, testEnv);
    expect(self.status).toBe(200);
    await expect(self.json()).resolves.toMatchObject({
      data: { id: admin.staff_id, mustChangePassword: true },
    });
  });

  it('enforces CSRF on unsafe methods', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie, csrf } = await standardSession(testEnv);

    const missing = await app().request('/api/platform-admin/tenants/tenant-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'suspended' }),
    }, testEnv);
    expect(missing.status).toBe(403);

    const allowed = await app().request('/api/platform-admin/tenants/tenant-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-platform-admin-csrf-token': csrf },
      body: JSON.stringify({ status: 'suspended' }),
    }, testEnv);
    expect(allowed.status).toBe(200);
  });

  it('rotates the credential version on password change and revokes the old session', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const login = await app().request('/api/platform-admin/login', loginRequest(), testEnv);
    const oldCookie = cookieHeader(login);
    const csrf = (await login.clone().json() as { csrfToken: string }).csrfToken;

    const wrongCurrent = await app().request('/api/platform-admin/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: oldCookie, 'x-platform-admin-csrf-token': csrf },
      body: JSON.stringify({ currentPassword: 'Nope nope nope', newPassword: 'Permanent password 84' }),
    }, testEnv);
    expect(wrongCurrent.status).toBe(401);

    const changed = await app().request('/api/platform-admin/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: oldCookie, 'x-platform-admin-csrf-token': csrf },
      body: JSON.stringify({ currentPassword: 'Temporary pass 42', newPassword: 'Permanent password 84' }),
    }, testEnv);
    expect(changed.status).toBe(200);
    expect(admin.credential_version).toBe(2);
    expect(admin.must_change_password).toBe(0);

    expect((await app().request('/api/platform-admin/session', { headers: { cookie: oldCookie } }, testEnv)).status)
      .toBe(401);
    expect((await app().request('/api/platform-admin/tenants', { headers: { cookie: cookieHeader(changed) } }, testEnv)).status)
      .toBe(200);
  });

  it('revokes the session on logout', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie, csrf } = await standardSession(testEnv);

    const logout = await app().request('/api/platform-admin/logout', {
      method: 'POST',
      headers: { cookie, 'x-platform-admin-csrf-token': csrf },
    }, testEnv);
    expect(logout.status).toBe(200);
    expect((await app().request('/api/platform-admin/session', { headers: { cookie } }, testEnv)).status).toBe(401);
  });
});

describe('platform admin cross-tenant access', () => {
  it('lists every tenant with its counts', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);

    const response = await app().request('/api/platform-admin/tenants', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        { id: 'tenant-a', tenantCode: 'pharmacy-a', status: 'active', patientCount: 3, staffCount: 2, lineAccountCount: 1 },
        { id: 'tenant-b', status: 'suspended' },
      ],
    });
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'list_tenants', tenant_id: null });
  });

  it('returns one tenant with its line accounts and 404s an unknown tenant', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);

    const response = await app().request('/api/platform-admin/tenants/tenant-a', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: 'tenant-a', lineAccounts: [{ id: 'account-a', name: 'Account A' }] },
    });
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'view_tenant', tenant_id: 'tenant-a' });

    const missing = await app().request('/api/platform-admin/tenants/tenant-zz', { headers: { cookie } }, testEnv);
    expect(missing.status).toBe(404);
  });

  it('edits only displayName and status, and audits the change atomically', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie, csrf } = await standardSession(testEnv);
    const patch = (body: unknown) => app().request('/api/platform-admin/tenants/tenant-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-platform-admin-csrf-token': csrf },
      body: JSON.stringify(body),
    }, testEnv);

    expect((await patch({ tenantCode: 'renamed' })).status).toBe(400);
    expect((await patch({ status: 'deleted' })).status).toBe(400);
    expect((await patch({ displayName: '' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(store.tenants[0]).toMatchObject({ tenant_code: 'pharmacy-a', display_name: 'Pharmacy A', status: 'active' });

    const ok = await patch({ displayName: 'Pharmacy A2', status: 'suspended' });
    expect(ok.status).toBe(200);
    expect(store.tenants[0]).toMatchObject({ display_name: 'Pharmacy A2', status: 'suspended' });
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'edit_tenant',
      tenant_id: 'tenant-a',
      resource_type: 'tenant',
      resource_id: 'tenant-a',
      detail_json: JSON.stringify({
        before: { displayName: 'Pharmacy A', status: 'active' },
        after: { displayName: 'Pharmacy A2', status: 'suspended' },
      }),
    });
  });

  it('lists tenant patients through the existing account-scoped repository', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);

    const response = await app().request('/api/platform-admin/tenants/tenant-a/patients', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [{ lineAccountId: 'account-a', id: 'patient-1' }],
    });
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'list_patients', tenant_id: 'tenant-a' });
  });

  it('assembles patient detail from the existing admin repositories, filtered to that patient', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);

    const response = await app().request(
      '/api/platform-admin/tenants/tenant-a/patients/patient-1',
      { headers: { cookie } },
      testEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        lineAccountId: 'account-a',
        patient: { id: 'patient-1' },
        prescriptions: [{ id: 'sub-1' }],
        nextIntakeExpectations: [{ id: 'exp-1' }],
        mynaHandoffs: [{ id: 'myna-1' }],
      },
    });
    const body = await (await app().request(
      '/api/platform-admin/tenants/tenant-a/patients/patient-1',
      { headers: { cookie } },
      testEnv,
    )).json() as { data: { nextIntakeExpectations: unknown[]; mynaHandoffs: unknown[] } };
    expect(body.data.nextIntakeExpectations).toHaveLength(1);
    expect(body.data.mynaHandoffs).toHaveLength(1);
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'view_patient',
      tenant_id: 'tenant-a',
      resource_type: 'patient',
      resource_id: 'patient-1',
    });

    const missing = await app().request(
      '/api/platform-admin/tenants/tenant-a/patients/patient-zz',
      { headers: { cookie } },
      testEnv,
    );
    expect(missing.status).toBe(404);
  });

  it('returns all three log sources by default and one when type is given', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);

    const all = await app().request('/api/platform-admin/logs', { headers: { cookie } }, testEnv);
    expect(all.status).toBe(200);
    await expect(all.json()).resolves.toMatchObject({
      data: {
        prescriptionEvents: [{ id: 'event-1' }],
        webhookReceipts: [{ webhook_event_id: 'w-1' }],
        platformAdminAccess: expect.any(Array),
      },
    });

    const single = await app().request('/api/platform-admin/logs?type=webhook_receipts&limit=999', { headers: { cookie } }, testEnv);
    const body = await single.json() as { data: Record<string, unknown> };
    expect(Object.keys(body.data)).toEqual(['webhookReceipts']);
    expect((await app().request('/api/platform-admin/logs?type=nope', { headers: { cookie } }, testEnv)).status).toBe(400);
    expect(store.auditEvents.filter((event) => event.action === 'view_logs')).toHaveLength(2);
  });

  it('returns the caller own audit trail without recording another event', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);
    const before = store.auditEvents.length;

    const response = await app().request('/api/platform-admin/audit', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    expect(store.auditEvents).toHaveLength(before);
  });
});

describe('platform admin audit coverage', () => {
  // The whole justification for a role that bypasses tenant isolation is that
  // every access it makes is recorded. A route added without an audit call is
  // a compliance regression, so every registered route must appear here.
  const EXEMPT = new Set([
    // Reading your own identity is not tenant-data access.
    'GET /api/platform-admin/session',
    // Reading your own audit trail would append to the trail being read.
    'GET /api/platform-admin/audit',
  ]);

  const FIXTURES: Record<string, { path: string; method: string; body?: unknown }> = {
    'POST /api/platform-admin/login': { path: '/api/platform-admin/login', method: 'POST' },
    'POST /api/platform-admin/logout': { path: '/api/platform-admin/logout', method: 'POST' },
    'POST /api/platform-admin/change-password': {
      path: '/api/platform-admin/change-password',
      method: 'POST',
      body: { currentPassword: 'Permanent password 84', newPassword: 'Third password 126' },
    },
    'GET /api/platform-admin/tenants': { path: '/api/platform-admin/tenants', method: 'GET' },
    'GET /api/platform-admin/tenants/:id': { path: '/api/platform-admin/tenants/tenant-a', method: 'GET' },
    'PATCH /api/platform-admin/tenants/:id': {
      path: '/api/platform-admin/tenants/tenant-a',
      method: 'PATCH',
      body: { status: 'suspended' },
    },
    'GET /api/platform-admin/tenants/:id/patients': {
      path: '/api/platform-admin/tenants/tenant-a/patients',
      method: 'GET',
    },
    'GET /api/platform-admin/tenants/:id/patients/:patientId': {
      path: '/api/platform-admin/tenants/tenant-a/patients/patient-1',
      method: 'GET',
    },
    'GET /api/platform-admin/logs': { path: '/api/platform-admin/logs', method: 'GET' },
  };

  it('covers every registered route with a fixture', () => {
    const registered = platformAdminRoutes.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => !EXEMPT.has(route));
    expect(new Set(registered)).toEqual(new Set(Object.keys(FIXTURES)));
  });

  it.each(Object.entries(FIXTURES))('writes an access event for %s', async (_name, fixture) => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const isLogin = fixture.path === '/api/platform-admin/login';
    const auth = isLogin ? { cookie: '', csrf: '' } : await standardSession(testEnv);
    const before = store.auditEvents.length;

    const response = await app().request(fixture.path, {
      method: fixture.method,
      headers: {
        'content-type': 'application/json',
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.csrf ? { 'x-platform-admin-csrf-token': auth.csrf } : {}),
      },
      body: isLogin
        ? JSON.stringify({ loginId: admin.login_id, password: 'Temporary pass 42' })
        : fixture.body === undefined ? undefined : JSON.stringify(fixture.body),
    }, testEnv);

    expect(response.status).toBe(200);
    expect(store.auditEvents.length).toBeGreaterThan(before);
  });
});
