import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { platformAdminAuthMiddleware } from './auth.js';
import { platformAdminOperationsRoutes } from './operations-routes.js';

vi.mock('@line-crm/db', () => ({ getStaffByApiKey: vi.fn(async () => null) }));

const credentialMocks = vi.hoisted(() => ({ readLineCredential: vi.fn() }));
vi.mock('../provisioning/line-credential-store.js', () => credentialMocks);

// Same shape line-proxy.test.ts / line-accounts.test.ts use: swap the client
// for a stub so nothing here ever reaches api.line.me.
const lineClientMocks = vi.hoisted(() => ({ request: vi.fn() }));
const lineSdkMocks = vi.hoisted(() => ({ LineClient: vi.fn() }));
vi.mock('@line-crm/line-sdk', () => lineSdkMocks);
lineSdkMocks.LineClient.mockImplementation(function () {
  return lineClientMocks;
});

const readinessMocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../readiness.js', () => ({ getPharmacyReadiness: readinessMocks.get }));

const SESSION_TOKEN = `pas_${'a'.repeat(43)}`;
const CSRF = 'csrf-value';
const AUTH = {
  cookie: `lh_platform_admin_session=${SESSION_TOKEN}; lh_platform_admin_csrf=${CSRF}`,
  'x-platform-admin-csrf-token': CSRF,
};

const NOW = '2026-08-19T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

beforeEach(() => {
  readinessMocks.get.mockImplementation(async (_db: D1Database, accountId: string) => ({
    accountId,
    checkedAt: '2026-08-21T00:00:00.000Z',
    electronicPrescription: { status: 'UNVERIFIED' },
    emergencyContraception: { status: 'BLOCKED' },
  }));
});

type SessionRow = { tenant_id: string; staff_id: string; expires_at: string; revoked_at: string | null };

type MembershipRow = { tenant_id: string; staff_id: string; role: string; is_active: number };

type Store = {
  db: D1Database;
  auditEvents: Array<Record<string, unknown>>;
  staffMembers: Array<{ id: string; name: string; email: string | null; is_active: number }>;
  memberships: MembershipRow[];
  sessions: SessionRow[];
};

function fakeDb(): Store {
  const auditEvents: Array<Record<string, unknown>> = [];
  const tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }];
  const staffMembers = [
    { id: 'staff-1', name: 'Aoi', email: 'aoi@example.test', is_active: 1 },
    { id: 'staff-2', name: 'Bea', email: null, is_active: 1 },
  ];
  const memberships: MembershipRow[] = [
    { tenant_id: 'tenant-a', staff_id: 'staff-1', role: 'admin', is_active: 1 },
    { tenant_id: 'tenant-b', staff_id: 'staff-2', role: 'owner', is_active: 1 },
  ];
  const sessions: SessionRow[] = [
    { tenant_id: 'tenant-a', staff_id: 'staff-1', expires_at: FUTURE, revoked_at: null },
    { tenant_id: 'tenant-a', staff_id: 'staff-1', expires_at: FUTURE, revoked_at: null },
    { tenant_id: 'tenant-a', staff_id: 'staff-1', expires_at: PAST, revoked_at: null },
    { tenant_id: 'tenant-a', staff_id: 'staff-1', expires_at: FUTURE, revoked_at: NOW },
    { tenant_id: 'tenant-b', staff_id: 'staff-2', expires_at: FUTURE, revoked_at: null },
  ];
  const lineAccounts = [
    {
      tenant_id: 'tenant-a', id: 'account-a', name: 'Account A', channel_id: '1000', is_active: 1,
      liff_id: 'liff-a', login_channel_id: 'login-a', bot_identity_count: 1,
      messaging_credential_count: 2, login_credential_count: 1,
      last_webhook_received_at: '2026-08-18T09:00:00.000Z',
    },
    {
      tenant_id: 'tenant-a', id: 'account-a2', name: 'Account A2', channel_id: '1001', is_active: 0,
      liff_id: null, login_channel_id: null, bot_identity_count: 0,
      messaging_credential_count: 0, login_credential_count: 0, last_webhook_received_at: null,
    },
    {
      tenant_id: 'tenant-b', id: 'account-b', name: 'Account B', channel_id: '2000', is_active: 1,
      liff_id: 'liff-b', login_channel_id: 'login-b', bot_identity_count: 1,
      messaging_credential_count: 2, login_credential_count: 1, last_webhook_received_at: null,
    },
  ];

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
            return {
              staff_id: 'staff-platform',
              name: 'Platform Owner',
              must_change_password: 0,
              credential_version: 1,
              session_kind: 'standard',
            };
          }
          if (sql.includes('FROM tenants')) {
            return tenants.find((tenant) => tenant.id === values[0]) ?? null;
          }
          if (sql.includes('FROM tenant_staff_memberships')) {
            return memberships.find((row) =>
              row.tenant_id === values[0] && row.staff_id === values[1]) ?? null;
          }
          if (sql.includes('FROM tenant_admin_sessions')) {
            return {
              count: sessions.filter((row) =>
                row.tenant_id === values[0] && row.revoked_at === null).length,
            };
          }
          if (sql.includes('FROM tenant_line_accounts')) {
            return lineAccounts.find((row) =>
              row.tenant_id === values[0] && row.id === values[1]) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM tenant_staff_memberships AS membership')) {
            const now = String(values[0]);
            return {
              results: memberships
                .filter((row) => row.tenant_id === values[1])
                .map((row) => {
                  const staff = staffMembers.find((member) => member.id === row.staff_id)!;
                  return {
                    staff_id: staff.id,
                    name: staff.name,
                    email: staff.email,
                    role: row.role,
                    staff_active: staff.is_active,
                    membership_active: row.is_active,
                    active_session_count: sessions.filter((session) =>
                      session.staff_id === staff.id && session.tenant_id === row.tenant_id &&
                      session.revoked_at === null && session.expires_at > now).length,
                  };
                }),
            };
          }
          if (sql.includes('FROM tenant_line_accounts AS mapping')) {
            return { results: lineAccounts.filter((row) => row.tenant_id === values[0]) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO platform_admin_access_events')) {
            auditEvents.push({
              platform_admin_id: values[1],
              tenant_id: values[2],
              action: values[3],
              resource_type: values[4],
              resource_id: values[5],
              detail_json: values[6],
            });
            return { meta: { changes: 1 } };
          }
          // Kept even though no route issues it any more: it is what makes
          // "the platform-wide staff row stays untouched" a real assertion
          // rather than a statement the fake could not contradict.
          if (sql.includes('UPDATE staff_members')) {
            const target = staffMembers.find((member) => member.id === values[1]);
            if (!target) return { meta: { changes: 0 } };
            target.is_active = 0;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE tenant_staff_memberships')) {
            const target = memberships.find((row) =>
              row.tenant_id === values[1] && row.staff_id === values[2]);
            if (!target) return { meta: { changes: 0 } };
            target.is_active = 0;
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE tenant_admin_sessions')) {
            const staffScoped = sql.includes('staff_id = ?');
            let changes = 0;
            for (const session of sessions) {
              if (session.revoked_at !== null) continue;
              if (session.tenant_id !== values[1]) continue;
              if (staffScoped && session.staff_id !== values[2]) continue;
              session.revoked_at = String(values[0]);
              changes += 1;
            }
            return { meta: { changes } };
          }
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
  return { db: db as unknown as D1Database, auditEvents, staffMembers, memberships, sessions };
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
    LIFF_PUBLIC_URL: 'https://liff.example.test',
    ADMIN_ORIGIN: 'https://admin.example.test',
    LINE_CREDENTIAL_KEY_V1: 'line-credential-root-key-for-tests',
    ...overrides,
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-token-key-for-tests',
  };
}

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('/api/platform-admin/*', platformAdminAuthMiddleware);
  instance.route('/', platformAdminOperationsRoutes);
  return instance;
}

function get(path: string, testEnv: Env['Bindings']) {
  return app().request(path, { headers: { cookie: AUTH.cookie } }, testEnv);
}

function post(path: string, testEnv: Env['Bindings']) {
  return app().request(path, { method: 'POST', headers: AUTH }, testEnv);
}

beforeEach(() => {
  credentialMocks.readLineCredential.mockReset();
  lineClientMocks.request.mockReset();
  lineSdkMocks.LineClient.mockClear();
});

describe('platform admin staff roster', () => {
  // Cache-Control lives on platformAdminAuthMiddleware, not on any one router,
  // so it must reach this router too — that shared placement is the only thing
  // stopping a future sibling router from shipping without it.
  it('marks responses no-store, inheriting the prefix-wide middleware', async () => {
    const response = await get('/api/platform-admin/tenants/tenant-a/staff', env(fakeDb().db));
    expect(response.headers.get('cache-control')).toBe('no-store, private');
  });

  it('lists this tenant staff with live session counts', async () => {
    const store = fakeDb();
    const response = await get('/api/platform-admin/tenants/tenant-a/staff', env(store.db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{
        staffId: 'staff-1',
        name: 'Aoi',
        email: 'aoi@example.test',
        role: 'admin',
        isActive: true,
        membershipActive: true,
        // Two live rows: the expired one and the revoked one do not count.
        activeSessionCount: 2,
      }],
    });
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'list_staff', tenant_id: 'tenant-a' });
  });

  it('404s an unknown tenant', async () => {
    const store = fakeDb();
    const response = await get('/api/platform-admin/tenants/tenant-zz/staff', env(store.db));
    expect(response.status).toBe(404);
    expect(store.auditEvents).toHaveLength(0);
  });
});

describe('platform admin staff disable', () => {
  it('deactivates the tenant membership and revokes their sessions for this tenant', async () => {
    const store = fakeDb();
    const response = await post(
      '/api/platform-admin/tenants/tenant-a/staff/staff-1/disable',
      env(store.db),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { staffId: 'staff-1', sessionsRevoked: 3 },
    });
    expect(store.memberships.find((row) =>
      row.tenant_id === 'tenant-a' && row.staff_id === 'staff-1')?.is_active).toBe(0);
    // The platform-wide staff_members row must NOT be touched:
    // platform_admins.staff_id points at it and the platform-admin login
    // INNER JOINs staff_members.is_active = 1, so clearing it here would lock a
    // platform admin out of the platform console from a tenant-scoped route.
    expect(store.staffMembers.find((staff) => staff.id === 'staff-1')?.is_active).toBe(1);
    expect(store.sessions.filter((session) =>
      session.tenant_id === 'tenant-a' && session.revoked_at === null)).toHaveLength(0);
    expect(store.sessions.filter((session) =>
      session.tenant_id === 'tenant-b' && session.revoked_at === null)).toHaveLength(1);
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'disable_staff',
      tenant_id: 'tenant-a',
      resource_type: 'staff',
      resource_id: 'staff-1',
    });
  });

  it('leaves the same staff member active in another tenant', async () => {
    const store = fakeDb();
    // No production path creates a staff row holding memberships in two
    // tenants today, so this fixture is built by hand. It exists to stop a
    // future path that does from silently re-introducing the cross-tenant
    // blast radius this route used to have.
    store.memberships.push({
      tenant_id: 'tenant-b', staff_id: 'staff-1', role: 'admin', is_active: 1,
    });

    const response = await post(
      '/api/platform-admin/tenants/tenant-a/staff/staff-1/disable',
      env(store.db),
    );

    expect(response.status).toBe(200);
    expect(store.memberships.find((row) =>
      row.tenant_id === 'tenant-a' && row.staff_id === 'staff-1')?.is_active).toBe(0);
    expect(store.memberships.find((row) =>
      row.tenant_id === 'tenant-b' && row.staff_id === 'staff-1')?.is_active).toBe(1);
    expect(store.staffMembers.find((staff) => staff.id === 'staff-1')?.is_active).toBe(1);
  });

  it('refuses a staff id that belongs to a different tenant', async () => {
    const store = fakeDb();
    const response = await post(
      '/api/platform-admin/tenants/tenant-a/staff/staff-2/disable',
      env(store.db),
    );

    expect(response.status).toBe(404);
    expect(store.staffMembers.find((staff) => staff.id === 'staff-2')?.is_active).toBe(1);
    expect(store.sessions.filter((session) =>
      session.tenant_id === 'tenant-b' && session.revoked_at === null)).toHaveLength(1);
    expect(store.auditEvents).toHaveLength(0);
  });
});

describe('platform admin tenant session revocation', () => {
  it('revokes every live session for the tenant and reports the count', async () => {
    const store = fakeDb();
    const response = await post('/api/platform-admin/tenants/tenant-a/revoke-sessions', env(store.db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: { revoked: 3 } });
    expect(store.sessions.filter((session) => session.revoked_at === null))
      .toEqual([expect.objectContaining({ tenant_id: 'tenant-b' })]);
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'revoke_tenant_sessions',
      tenant_id: 'tenant-a',
      detail_json: JSON.stringify({ revoked: 3 }),
    });
  });

  it('404s an unknown tenant without touching any session', async () => {
    const store = fakeDb();
    const response = await post('/api/platform-admin/tenants/tenant-zz/revoke-sessions', env(store.db));
    expect(response.status).toBe(404);
    expect(store.sessions.filter((session) => session.revoked_at === null)).toHaveLength(4);
  });
});

describe('platform admin LINE status', () => {
  it('reports presence booleans only, never credential material', async () => {
    const store = fakeDb();
    const response = await get('/api/platform-admin/tenants/tenant-a/line-status', env(store.db));

    expect(response.status).toBe(200);
    const body = await response.json() as { data: unknown };
    expect(body).toEqual({
      success: true,
      data: [
        {
          id: 'account-a',
          name: 'Account A',
          channelId: '1000',
          isActive: true,
          hasBotIdentity: true,
          hasEncryptedCredential: true,
          liffIdConfigured: true,
          loginChannelConfigured: true,
          messagingCredentialsReady: true,
          loginCredentialReady: true,
          expectedLiffEndpoint: 'https://liff.example.test/?liffId=liff-a',
          liffEndpointEvidence: { status: 'UNVERIFIED', source: 'manual_console', checkedAt: null },
          lastWebhookReceivedAt: '2026-08-18T09:00:00.000Z',
          readiness: {
            accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
            electronicPrescription: { status: 'UNVERIFIED' },
            emergencyContraception: { status: 'BLOCKED' },
          },
        },
        {
          id: 'account-a2',
          name: 'Account A2',
          channelId: '1001',
          isActive: false,
          hasBotIdentity: false,
          hasEncryptedCredential: false,
          liffIdConfigured: false,
          loginChannelConfigured: false,
          messagingCredentialsReady: false,
          loginCredentialReady: false,
          expectedLiffEndpoint: null,
          liffEndpointEvidence: { status: 'UNVERIFIED', source: 'manual_console', checkedAt: null },
          lastWebhookReceivedAt: null,
          readiness: {
            accountId: 'account-a2', checkedAt: '2026-08-21T00:00:00.000Z',
            electronicPrescription: { status: 'UNVERIFIED' },
            emergencyContraception: { status: 'BLOCKED' },
          },
        },
      ],
    });
    // Neither the word "token" nor "secret" may appear anywhere in the
    // payload — not as a value, and not as a field name that could carry one.
    expect(JSON.stringify(body)).not.toMatch(/token|secret/iu);
    expect(store.auditEvents.at(-1)).toMatchObject({ action: 'view_line_status', tenant_id: 'tenant-a' });
  });

  it('404s an unknown tenant', async () => {
    const store = fakeDb();
    expect((await get('/api/platform-admin/tenants/tenant-zz/line-status', env(store.db))).status).toBe(404);
  });
});

describe('platform admin LINE connection test', () => {
  const path = '/api/platform-admin/tenants/tenant-a/line-accounts/account-a/test-connection';

  it('reports the bot identity when LINE answers', async () => {
    const store = fakeDb();
    credentialMocks.readLineCredential.mockResolvedValue('channel-access-token');
    lineClientMocks.request.mockResolvedValue({
      data: { userId: 'Ubotuser0001', displayName: 'Pharmacy A Bot' },
      headers: new Headers(),
    });

    const response = await post(path, env(store.db));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { ok: true, botUserId: 'Ubotuser0001', displayName: 'Pharmacy A Bot' },
    });
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'line-credential-root-key-for-tests',
      { tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token' },
    );
    expect(lineClientMocks.request).toHaveBeenCalledWith('GET', '/v2/bot/info');
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'test_line_connection',
      tenant_id: 'tenant-a',
      resource_type: 'line_account',
      resource_id: 'account-a',
      detail_json: JSON.stringify({ ok: true }),
    });
  });

  it('returns ok:false rather than a 500 when LINE rejects the call', async () => {
    const store = fakeDb();
    credentialMocks.readLineCredential.mockResolvedValue('channel-access-token');
    lineClientMocks.request.mockRejectedValue(
      new Error('LINE API error: 401 Unauthorized — {"message":"Authentication failed"}'),
    );

    const response = await post(path, env(store.db));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { ok: boolean; error: string } };
    expect(body.data).toEqual({ ok: false, error: 'LINE API request failed' });
    // The upstream body is never echoed back, so it cannot smuggle out
    // anything the response promised not to expose.
    expect(JSON.stringify(body)).not.toMatch(/Authentication failed/u);
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'test_line_connection',
      detail_json: JSON.stringify({ ok: false, error: 'LINE API request failed' }),
    });
  });

  it('returns ok:false when the credential cannot be decrypted', async () => {
    const store = fakeDb();
    credentialMocks.readLineCredential.mockResolvedValue(null);

    const response = await post(path, env(store.db));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { ok: false, error: 'LINE credential unavailable' },
    });
    expect(lineSdkMocks.LineClient).not.toHaveBeenCalled();
  });

  it('refuses a LINE account owned by another tenant, before probing anything', async () => {
    const store = fakeDb();
    const response = await post(
      '/api/platform-admin/tenants/tenant-a/line-accounts/account-b/test-connection',
      env(store.db),
    );

    expect(response.status).toBe(404);
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(lineSdkMocks.LineClient).not.toHaveBeenCalled();
    expect(store.auditEvents).toHaveLength(0);
  });
});

describe('platform admin operations audit coverage', () => {
  // Same guard routes.test.ts applies to the main router: a cross-tenant route
  // added without an access event is a compliance regression, so every
  // registered route must have a fixture here that proves it writes one.
  const FIXTURES: Record<string, { path: string; method: 'GET' | 'POST' }> = {
    'GET /api/platform-admin/tenants/:id/staff': {
      path: '/api/platform-admin/tenants/tenant-a/staff', method: 'GET',
    },
    'POST /api/platform-admin/tenants/:id/staff/:staffId/disable': {
      path: '/api/platform-admin/tenants/tenant-a/staff/staff-1/disable', method: 'POST',
    },
    'POST /api/platform-admin/tenants/:id/revoke-sessions': {
      path: '/api/platform-admin/tenants/tenant-a/revoke-sessions', method: 'POST',
    },
    'GET /api/platform-admin/tenants/:id/line-status': {
      path: '/api/platform-admin/tenants/tenant-a/line-status', method: 'GET',
    },
    'POST /api/platform-admin/tenants/:id/line-accounts/:lineAccountId/test-connection': {
      path: '/api/platform-admin/tenants/tenant-a/line-accounts/account-a/test-connection',
      method: 'POST',
    },
  };

  it('covers every registered route with a fixture', () => {
    const registered = platformAdminOperationsRoutes.routes
      .map((route) => `${route.method} ${route.path}`);
    expect(new Set(registered)).toEqual(new Set(Object.keys(FIXTURES)));
  });

  it.each(Object.entries(FIXTURES))('writes an access event for %s', async (_name, fixture) => {
    const store = fakeDb();
    credentialMocks.readLineCredential.mockResolvedValue('channel-access-token');
    lineClientMocks.request.mockResolvedValue({
      data: { userId: 'Ubotuser0001', displayName: 'Bot' }, headers: new Headers(),
    });

    const response = fixture.method === 'GET'
      ? await get(fixture.path, env(store.db))
      : await post(fixture.path, env(store.db));

    expect(response.status).toBe(200);
    expect(store.auditEvents.length).toBeGreaterThan(0);
  });
});
