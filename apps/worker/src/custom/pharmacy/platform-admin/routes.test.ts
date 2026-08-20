import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { hashTenantPassword } from '../provisioning/credentials.js';
import { platformAdminAuthMiddleware } from './auth.js';
import { platformAdminRoutes } from './routes.js';

vi.mock('@line-crm/db', () => ({ getStaffByApiKey: vi.fn(async () => null) }));

// The manual webhook retry reuses the durable-inbox runner rather than
// reimplementing event processing; the route's contract is "reset the row,
// then hand it to that one function", which is what this double asserts.
const webhookRetry = vi.hoisted(() =>
  vi.fn(async (_runner: unknown, _row: unknown) => 'completed' as const));
vi.mock('../../../routes/webhook.js', () => ({ runWebhookInboxEvent: webhookRetry }));

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

// Mirrors the real listMynaHandoffs contract: the patient filter is applied
// in SQL, so a caller passing patientId gets only that patient's rows back.
// The route relies on this rather than filtering the result, because the real
// query pages at LIMIT 100 and a post-hoc filter would drop rows.
vi.mock('../myna/repository.js', () => ({
  listMynaHandoffs: vi.fn(async (
    _db: unknown,
    _lineAccountId: string,
    _status?: string,
    patientId?: string,
  ) => [
    { id: 'myna-1', patient_id: 'patient-1' },
    { id: 'myna-2', patient_id: 'patient-other' },
  ].filter((row) => !patientId || row.patient_id === patientId)),
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
  {
    id: 'tenant-a', tenant_code: 'pharmacy-a', display_name: 'Pharmacy A',
    status: 'active', outbound_messaging_paused_at: null as string | null,
  },
  {
    id: 'tenant-b', tenant_code: 'pharmacy-b', display_name: 'Pharmacy B',
    status: 'suspended', outbound_messaging_paused_at: null as string | null,
  },
];

type Session = {
  staffId: string;
  credentialVersion: number;
  kind: 'bootstrap' | 'standard';
  expiresAt: string;
  revokedAt: string | null;
};

type Grant = {
  id: string;
  platform_admin_id: string;
  tenant_id: string;
  scopes: string;
  reason: string;
  ticket_reference: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  /** NULL = issued before custom_031, i.e. not bound to any session. */
  session_token_hash: string | null;
};

type WebhookReceipt = {
  tenant_id: string;
  line_account_id: string;
  webhook_event_id: string;
  payload: string | null;
  status: string;
  retry_count: number;
  dead_lettered_at: string | null;
  lease_until: string | null;
};

type Store = {
  db: D1Database;
  auditEvents: Array<Record<string, unknown>>;
  tenants: typeof tenants;
  grants: Grant[];
  receipts: WebhookReceipt[];
  /**
   * Makes the NEXT webhook-receipt SELECT return this snapshot instead of the
   * live row — the read-then-update window a concurrent retry (or the cron
   * sweep) lands in. Only the UPDATE's own eligibility predicate can close it.
   */
  staleReceiptRead(row: WebhookReceipt): void;
};

/**
 * An active, unexpired, unrevoked phi:read grant — support mode is ON.
 * session_token_hash defaults to null: a legacy, pre-custom_031 grant.
 */
function seedGrant(store: Store, overrides: Partial<Grant> = {}): Grant {
  const grant: Grant = {
    id: 'grant-fixture',
    platform_admin_id: admin.staff_id,
    tenant_id: 'tenant-a',
    scopes: JSON.stringify(['phi:read']),
    reason: 'Investigating a delivery complaint',
    ticket_reference: 'OPS-1',
    issued_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    revoked_at: null,
    session_token_hash: null,
    ...overrides,
  };
  store.grants.push(grant);
  return grant;
}

function fakeDb(): Store {
  const sessions = new Map<string, Session>();
  const auditEvents: Array<Record<string, unknown>> = [];
  const rows = tenants.map((tenant) => ({ ...tenant }));
  const grants: Grant[] = [];
  const receipts: WebhookReceipt[] = [
    {
      tenant_id: 'tenant-a', line_account_id: 'account-a', webhook_event_id: 'wh-failed',
      payload: '{"type":"message"}', status: 'failed',
      retry_count: 3, dead_lettered_at: null, lease_until: '2026-01-01T00:00:00.000Z',
    },
    {
      tenant_id: 'tenant-a', line_account_id: 'account-a', webhook_event_id: 'wh-done',
      payload: '{"type":"message"}', status: 'completed',
      retry_count: 1, dead_lettered_at: null, lease_until: null,
    },
    {
      tenant_id: 'tenant-b', line_account_id: 'account-b', webhook_event_id: 'wh-other-tenant',
      payload: '{"type":"message"}', status: 'failed',
      retry_count: 10, dead_lettered_at: '2026-01-02T00:00:00.000Z', lease_until: null,
    },
  ];
  const stats = {
    line_account_count: 1,
    staff_count: 2,
    patient_count: 3,
    webhook_failure_count: 1,
    line_config_issue_count: 0,
  };
  let staleReceipt: WebhookReceipt | null = null;

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
          // requireActiveGrant: this admin, this exact tenant, unrevoked,
          // unexpired, and either unbound (legacy) or bound to THIS session.
          if (sql.includes('FROM platform_admin_access_grants')) {
            const bound = sql.includes('session_token_hash');
            return grants
              .filter((grant) => grant.platform_admin_id === values[0] &&
                grant.tenant_id === values[1] &&
                !grant.revoked_at &&
                grant.expires_at > String(values[2]) &&
                (!bound || !grant.session_token_hash || grant.session_token_hash === values[3]))
              .sort((left, right) => (left.expires_at < right.expires_at ? 1 : -1))[0] ?? null;
          }
          if (sql.includes('FROM tenants AS tenant')) {
            const found = rows.find((tenant) => tenant.id === values[0]);
            return found ? { ...found, ...stats } : null;
          }
          if (sql.includes('FROM pharmacy_webhook_event_receipts')) {
            if (staleReceipt) {
              const snapshot = staleReceipt;
              staleReceipt = null;
              return snapshot;
            }
            return receipts.find((receipt) => receipt.tenant_id === values[0] &&
              receipt.webhook_event_id === values[1]) ?? null;
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
          // listActiveGrants: every unrevoked, unexpired grant this admin holds.
          if (sql.includes('FROM platform_admin_access_grants')) {
            return {
              results: grants.filter((grant) => grant.platform_admin_id === values[0] &&
                !grant.revoked_at && grant.expires_at > String(values[1])),
            };
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
          if (sql.includes('INSERT INTO platform_admin_access_grants')) {
            grants.push({
              id: String(values[0]),
              platform_admin_id: String(values[1]),
              tenant_id: String(values[2]),
              scopes: String(values[3]),
              reason: String(values[4]),
              ticket_reference: values[5] as string | null,
              issued_at: String(values[7]),
              expires_at: String(values[8]),
              revoked_at: null,
              session_token_hash: (values[9] as string | null) ?? null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE platform_admin_access_grants')) {
            // endAccessGrant targets one grant; the change-password batch
            // revokes every active grant this admin holds.
            const targets = sql.includes('WHERE id = ?')
              ? grants.filter((grant) => grant.id === values[2] &&
                grant.platform_admin_id === values[3] && !grant.revoked_at)
              : grants.filter((grant) => grant.platform_admin_id === values[2] && !grant.revoked_at);
            for (const grant of targets) grant.revoked_at = String(values[0]);
            return { meta: { changes: targets.length } };
          }
          if (sql.includes('UPDATE pharmacy_webhook_event_receipts')) {
            const target = receipts.find((receipt) => receipt.tenant_id === values[0] &&
              receipt.line_account_id === values[1] && receipt.webhook_event_id === values[2]);
            if (!target) return { meta: { changes: 0 } };
            // The claim is only atomic if eligibility is re-checked by the
            // UPDATE itself; a WHERE without it matches whatever the row
            // became after the SELECT.
            if (sql.includes("status = 'failed' OR dead_lettered_at IS NOT NULL") &&
                target.status !== 'failed' && !target.dead_lettered_at) {
              return { meta: { changes: 0 } };
            }
            Object.assign(target, {
              status: 'pending', retry_count: 0, dead_lettered_at: null, lease_until: null,
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('outbound_messaging_paused_at')) {
            const target = rows.find((tenant) => tenant.id === values[2]);
            if (!target) return { meta: { changes: 0 } };
            target.outbound_messaging_paused_at = values[0] as string | null;
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
  return {
    db: db as unknown as D1Database,
    auditEvents,
    tenants: rows,
    grants,
    receipts,
    staleReceiptRead(row: WebhookReceipt) {
      staleReceipt = row;
    },
  };
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

type Auth = { cookie: string; csrf: string };

/**
 * A SECOND live session for the same admin. Plain login, no password change,
 * so the session standardSession() handed out stays valid alongside it —
 * which is exactly the "same admin, two browsers" shape a stolen cookie has.
 */
async function secondSession(testEnv: Env['Bindings']): Promise<Auth> {
  const login = await app().request(
    '/api/platform-admin/login',
    loginRequest('Permanent password 84'),
    testEnv,
  );
  expect(login.status).toBe(200);
  return {
    cookie: cookieHeader(login),
    csrf: (await login.json() as { csrfToken: string }).csrfToken,
  };
}

function postAs(testEnv: Env['Bindings'], auth: Auth, path: string, body?: unknown) {
  return app().request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: auth.cookie,
      'x-platform-admin-csrf-token': auth.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
}

/** Status of the PHI list route — the thing a support-mode grant gates. */
async function patientsStatus(testEnv: Env['Bindings'], cookie: string, tenantId: string) {
  const response = await app().request(
    `/api/platform-admin/tenants/${tenantId}/patients`,
    { headers: { cookie } },
    testEnv,
  );
  return response.status;
}

beforeEach(async () => {
  webhookRetry.mockClear();
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

  it('revokes open support-mode grants on logout, not just the session', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    seedGrant(store);
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(200);

    const logout = await postAs(testEnv, auth, '/api/platform-admin/logout');
    expect(logout.status).toBe(200);
    // Otherwise a grant outlives the session that opened it by up to an hour.
    expect(store.grants[0].revoked_at).not.toBeNull();
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
        {
          id: 'tenant-a', tenantCode: 'pharmacy-a', status: 'active', patientCount: 3,
          staffCount: 2, lineAccountCount: 1, webhookFailureCount: 1, lineConfigIssueCount: 0,
        },
        { id: 'tenant-b', status: 'suspended' },
      ],
    });
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'list_tenants', tenant_id: null });
  });

  it('returns one tenant with its line accounts and 404s an unknown tenant', async () => {
    const store = fakeDb();
    store.tenants[0].outbound_messaging_paused_at = '2026-08-19T08:00:00.000Z';
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);

    const response = await app().request('/api/platform-admin/tenants/tenant-a', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        id: 'tenant-a',
        outboundMessagingPausedAt: '2026-08-19T08:00:00.000Z',
        lineAccounts: [{ id: 'account-a', name: 'Account A' }],
      },
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
    // PHI needs an active support-mode grant, not just a session.
    seedGrant(store);

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
    seedGrant(store);

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
    // Reading your own open support-mode grants is a self-check, like /session;
    // the grant's issue and end are both audited on their own.
    'GET /api/platform-admin/support-grants/active',
  ]);

  // Only platformAdminRoutes' own registrations are enumerated below. The
  // platform-admin dashboard/operations routers are separate Hono instances
  // and carry their own audit-coverage tests.
  const FIXTURES: Record<string, { path: string; method: string; body?: unknown; status?: number }> = {
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
    'POST /api/platform-admin/tenants/:id/outbound-messaging': {
      path: '/api/platform-admin/tenants/tenant-a/outbound-messaging',
      method: 'POST',
      body: { paused: true },
    },
    'POST /api/platform-admin/tenants/:id/webhook-events/:webhookEventId/retry': {
      path: '/api/platform-admin/tenants/tenant-a/webhook-events/wh-failed/retry',
      method: 'POST',
    },
    'POST /api/platform-admin/tenants/:id/support-grants': {
      path: '/api/platform-admin/tenants/tenant-a/support-grants',
      method: 'POST',
      status: 201,
      body: {
        reason: 'Investigating a delivery complaint',
        ticketReference: 'OPS-2',
        scopes: ['phi:read'],
        currentPassword: 'Permanent password 84',
      },
    },
    'POST /api/platform-admin/support-grants/:grantId/end': {
      path: '/api/platform-admin/support-grants/grant-fixture/end',
      method: 'POST',
    },
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
    // Support mode is on: the PHI fixtures need it, and the grant-end fixture
    // needs a grant to end. Seeded after standardSession, whose password change
    // deliberately revokes every open grant.
    if (!isLogin) seedGrant(store);
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

    expect(response.status).toBe(fixture.status ?? 200);
    expect(store.auditEvents.length).toBeGreaterThan(before);
  });
});

describe('platform admin support-mode grants', () => {
  const GRANT_BODY = {
    reason: 'Investigating a delivery complaint',
    ticketReference: 'OPS-7',
    scopes: ['phi:read'],
    currentPassword: 'Permanent password 84',
  };
  const startGrant = (testEnv: Env['Bindings'], auth: Auth, tenantId = 'tenant-a', body = GRANT_BODY) =>
    postAs(testEnv, auth, `/api/platform-admin/tenants/${tenantId}/support-grants`, body);

  it('requires the current password again even with a valid session', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);

    const wrong = await startGrant(testEnv, auth, 'tenant-a', {
      ...GRANT_BODY, currentPassword: 'Not my password 99',
    });
    expect(wrong.status).toBe(401);
    expect(store.grants).toHaveLength(0);
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(403);

    const granted = await startGrant(testEnv, auth);
    expect(granted.status).toBe(201);
    expect(store.grants).toHaveLength(1);
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(200);
    expect(store.auditEvents.some((event) => event.action === 'support_mode_started')).toBe(true);
  });

  it('scopes a grant to exactly the tenant it was issued for', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    expect((await startGrant(testEnv, auth, 'tenant-a')).status).toBe(201);

    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(200);
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-b')).toBe(403);
    const detail = await app().request(
      '/api/platform-admin/tenants/tenant-b/patients/patient-1',
      { headers: { cookie: auth.cookie } },
      testEnv,
    );
    expect(detail.status).toBe(403);
  });

  it('stops honouring a grant once it has expired', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    seedGrant(store, {
      issued_at: new Date(Date.now() - 3_600_000).toISOString(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(403);
  });

  it('revokes the grant when support mode is ended', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    const created = await startGrant(testEnv, auth);
    const grantId = (await created.json() as { data: { id: string } }).data.id;
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(200);

    const active = await app().request(
      '/api/platform-admin/support-grants/active',
      { headers: { cookie: auth.cookie } },
      testEnv,
    );
    await expect(active.json()).resolves.toMatchObject({ data: [{ id: grantId }] });

    const ended = await postAs(testEnv, auth, `/api/platform-admin/support-grants/${grantId}/end`);
    expect(ended.status).toBe(200);
    expect(store.grants[0].revoked_at).not.toBeNull();
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(403);
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'support_mode_ended', resource_type: 'access_grant', resource_id: grantId,
    });

    // Ending an already-ended grant is not a second revocation.
    expect((await postAs(testEnv, auth, `/api/platform-admin/support-grants/${grantId}/end`)).status)
      .toBe(404);
  });

  it('revokes every open grant when the admin changes password', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    expect((await startGrant(testEnv, auth)).status).toBe(201);
    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(200);

    const changed = await postAs(testEnv, auth, '/api/platform-admin/change-password', {
      currentPassword: 'Permanent password 84',
      newPassword: 'Third password 126',
    });
    expect(changed.status).toBe(200);
    expect(store.grants[0].revoked_at).not.toBeNull();
    expect(await patientsStatus(testEnv, cookieHeader(changed), 'tenant-a')).toBe(403);
  });

  it('binds a grant to the session that opened it', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const sessionA = await standardSession(testEnv);
    const sessionB = await secondSession(testEnv);

    expect((await startGrant(testEnv, sessionA)).status).toBe(201);
    expect(store.grants[0].session_token_hash).toEqual(expect.any(String));

    expect(await patientsStatus(testEnv, sessionA.cookie, 'tenant-a')).toBe(200);
    // Same admin, different session: a stolen cookie must not inherit the
    // break-glass access another browser re-authenticated for.
    expect(await patientsStatus(testEnv, sessionB.cookie, 'tenant-a')).toBe(403);
  });

  it('still honours a legacy grant issued before session binding existed', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    // custom_031 is additive and nullable so an upgrade does not void the
    // grants an on-call admin is holding mid-incident.
    seedGrant(store, { session_token_hash: null });

    expect(await patientsStatus(testEnv, auth.cookie, 'tenant-a')).toBe(200);
  });
});

describe('platform admin tenant operations', () => {
  it('pauses and resumes outbound messaging for one tenant', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    const path = '/api/platform-admin/tenants/tenant-a/outbound-messaging';

    const paused = await postAs(testEnv, auth, path, { paused: true });
    expect(paused.status).toBe(200);
    expect(store.tenants[0].outbound_messaging_paused_at).toEqual(expect.any(String));
    expect(store.tenants[1].outbound_messaging_paused_at).toBeNull();
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'pause_outbound_messaging', tenant_id: 'tenant-a', resource_id: 'tenant-a',
    });

    const resumed = await postAs(testEnv, auth, path, { paused: false });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      data: { id: 'tenant-a', outboundMessagingPausedAt: null },
    });
    expect(store.tenants[0].outbound_messaging_paused_at).toBeNull();
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'resume_outbound_messaging' });
  });

  it('rejects a non-boolean pause flag and an unknown tenant', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);

    expect((await postAs(testEnv, auth, '/api/platform-admin/tenants/tenant-a/outbound-messaging',
      { paused: 'yes' })).status).toBe(400);
    expect((await postAs(testEnv, auth, '/api/platform-admin/tenants/tenant-zz/outbound-messaging',
      { paused: true })).status).toBe(404);
    expect(store.auditEvents.some((event) =>
      String(event.action).endsWith('_outbound_messaging'))).toBe(false);
  });

  it('retries a failed webhook event through the shared inbox runner', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);

    const response = await postAs(
      testEnv, auth, '/api/platform-admin/tenants/tenant-a/webhook-events/wh-failed/retry',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { webhookEventId: 'wh-failed', outcome: 'completed' },
    });
    // The row is handed to the runner reset, not deleted and not re-inserted.
    expect(store.receipts[0]).toMatchObject({
      status: 'pending', retry_count: 0, dead_lettered_at: null, lease_until: null,
    });
    expect(webhookRetry).toHaveBeenCalledOnce();
    expect(webhookRetry.mock.calls[0][1]).toMatchObject({
      tenant_id: 'tenant-a', line_account_id: 'account-a', webhook_event_id: 'wh-failed',
    });
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'retry_webhook_event',
      tenant_id: 'tenant-a',
      resource_type: 'webhook_event',
      resource_id: 'wh-failed',
    });
  });

  it('retries a dead-lettered event but refuses settled, unknown and cross-tenant ones', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    const retry = (tenantId: string, eventId: string) => postAs(
      testEnv, auth, `/api/platform-admin/tenants/${tenantId}/webhook-events/${eventId}/retry`,
    );

    // The cron sweep still owns completed rows; replaying one repeats side effects.
    expect((await retry('tenant-a', 'wh-done')).status).toBe(400);
    expect((await retry('tenant-a', 'wh-missing')).status).toBe(404);
    // tenant-b owns wh-other-tenant, so tenant-a must not see it at all.
    expect((await retry('tenant-a', 'wh-other-tenant')).status).toBe(404);
    expect(webhookRetry).not.toHaveBeenCalled();
    expect(store.receipts[1].status).toBe('completed');

    // Dead-lettered rows are exactly what manual retry exists for.
    expect((await retry('tenant-b', 'wh-other-tenant')).status).toBe(200);
    expect(store.receipts[2]).toMatchObject({ status: 'pending', dead_lettered_at: null, retry_count: 0 });
  });

  it('409s a duplicate retry instead of stealing the winner lease', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const auth = await standardSession(testEnv);
    const retry = () => postAs(
      testEnv, auth, '/api/platform-admin/tenants/tenant-a/webhook-events/wh-failed/retry',
    );
    const eligible = { ...store.receipts[0] };

    expect((await retry()).status).toBe(200);
    expect(webhookRetry).toHaveBeenCalledOnce();
    // The winner (here the runner, in production also the cron sweep) now
    // holds the row: pending, leased, no longer eligible for manual retry.
    store.receipts[0].lease_until = '2026-06-01T00:00:00.000Z';

    // The loser's SELECT still saw the pre-retry `failed` row, so only the
    // UPDATE's own eligibility predicate can stop it.
    store.staleReceiptRead(eligible);
    const loser = await retry();
    expect(loser.status).toBe(409);
    expect(webhookRetry).toHaveBeenCalledOnce();
    expect(store.receipts[0].lease_until).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('platform admin response caching', () => {
  // Every response here carries tenant-operational data, and the patient
  // routes carry PHI. None of it may sit in a shared or disk cache.
  it('marks responses no-store on operational and PHI routes alike', async () => {
    const store = fakeDb();
    const testEnv = env(store.db);
    const { cookie } = await standardSession(testEnv);
    seedGrant(store);

    const list = await app().request('/api/platform-admin/tenants', { headers: { cookie } }, testEnv);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store, private');

    const phi = await app().request(
      '/api/platform-admin/tenants/tenant-a/patients/patient-1',
      { headers: { cookie } },
      testEnv,
    );
    expect(phi.status).toBe(200);
    expect(phi.headers.get('cache-control')).toBe('no-store, private');
  });
});
