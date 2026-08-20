import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db so we can assert on the values the route forwards to the
// DB layer without needing a real D1Database. The route's responsibility is
// "normalize body → call DB function with correct args", so capturing those
// args is the meaningful assertion.
const dbMocks = {
  getLineAccounts: vi.fn(),
  getLineAccountById: vi.fn(),
  getLineAccountsForTenant: vi.fn(),
  getLineAccountByIdForTenant: vi.fn(),
  createLineAccount: vi.fn(),
  updateLineAccount: vi.fn(),
  updateLineAccountFields: vi.fn(),
  updateLineAccountOrder: vi.fn(),
  deleteLineAccount: vi.fn(),
  getAccountSetting: vi.fn(),
  setAccountSetting: vi.fn(),
  jstNow: vi.fn(() => '2026-08-10T12:00:00.000+09:00'),
};
vi.mock('@line-crm/db', () => dbMocks);

const credentialMocks = {
  readLineCredential: vi.fn(),
  writeLineCredential: vi.fn(),
  deleteLineCredential: vi.fn(),
};
vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentialMocks);

const atomicAccountMocks = {
  LINE_ACCOUNT_CONFLICT_ERROR: 'LINE account changed concurrently',
  createEncryptedLineAccount: vi.fn(),
  updateEncryptedLineAccount: vi.fn(),
};
vi.mock('../custom/pharmacy/provisioning/line-account-store.js', () => atomicAccountMocks);

const lineClientMocks = {
  getFollowersInsight: vi.fn(),
  getFollowerIds: vi.fn(),
  request: vi.fn(),
};
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () {
    return lineClientMocks;
  }),
}));

const boundaryMocks = {
  accountResourceOwnedByStaff: vi.fn(),
};
vi.mock('../middleware/tenant-boundary.js', () => boundaryMocks);

// Re-import after mock so the module picks up mocked deps.
const { lineAccounts } = await import('./line-accounts.js');

type TestEnv = {
  Variables: {
    staff: { id: string; role: 'owner' | 'admin' | 'staff' };
    tenantId: string;
  };
  Bindings: {
    DB: D1Database;
    WORKER_URL: string;
    WORKER_PUBLIC_URL: string;
    LINE_CREDENTIAL_KEY_V1: string;
  };
};

// Minimal D1 stub: every prepare/bind/first chain resolves to `null` (no row).
// Used for the uniqueness check in checkUniqueLoginAndLiff — tests that need
// to assert duplicate-rejection override `firstResult` per request.
function makeDbStub(firstResult: unknown = null): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(
          sql.includes('pharmacy_account_capabilities') ? null : firstResult,
        ),
      })),
    })),
  } as unknown as D1Database;
}

function makePharmacyDbStub(): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(
          sql.includes('SELECT mode FROM pharmacy_account_capabilities')
            ? { mode: 'pharmacy' }
            : sql.includes('pharmacy_account_capabilities')
              ? { pharmacy_install: 1 }
              : null,
        ),
      })),
    })),
  } as unknown as D1Database;
}

function setupApp(
  role: 'owner' | 'admin' | 'staff' = 'owner',
  dbStub: D1Database = makeDbStub(),
) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'test-staff', role });
    c.set('tenantId', 'tenant-a');
    c.env = {
      DB: dbStub,
      WORKER_URL: 'https://api.example.test',
      WORKER_PUBLIC_URL: 'https://api.example.test',
      LINE_CREDENTIAL_KEY_V1: 'synthetic-line-credential-root-v1',
    };
    await next();
  });
  app.route('/', lineAccounts);
  return app;
}

const fakeAccount = {
  id: 'acc-1',
  channel_id: '123456789',
  name: 'メイン',
  channel_access_token: 'token',
  channel_secret: 'secret',
  login_channel_id: null,
  login_channel_secret: null,
  liff_id: null,
  is_active: 1,
  country: null,
  role: null,
  display_order: 0,
  token_expires_at: null,
  created_at: '2026-05-08T00:00:00.000',
  updated_at: '2026-05-08T00:00:00.000',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  lineClientMocks.getFollowersInsight.mockReset();
  lineClientMocks.getFollowerIds.mockReset();
  lineClientMocks.request.mockReset();
  for (const fn of Object.values(credentialMocks)) fn.mockReset();
  atomicAccountMocks.createEncryptedLineAccount.mockReset();
  atomicAccountMocks.updateEncryptedLineAccount.mockReset();
  atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue(fakeAccount);
  boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
  credentialMocks.readLineCredential.mockResolvedValue('encrypted-access-token');
  credentialMocks.writeLineCredential.mockResolvedValue({ revision: 1 });
  credentialMocks.deleteLineCredential.mockResolvedValue(true);
  dbMocks.getAccountSetting.mockResolvedValue(null);
  dbMocks.setAccountSetting.mockResolvedValue(undefined);
  dbMocks.jstNow.mockReturnValue('2026-08-10T12:00:00.000+09:00');
  lineClientMocks.getFollowerIds.mockResolvedValue({ userIds: [] });
});

describe('POST /api/line-accounts/:id/connect', () => {
  function connectionDb(batchError?: Error) {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const batch = vi.fn(async () => {
      if (batchError) throw batchError;
      return statements.map(() => ({ meta: { changes: 1 } }));
    });
    const db = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            statement.values = values;
            statements.push(statement);
            return statement;
          },
        };
        return statement;
      }),
      batch,
    } as unknown as D1Database;
    return { db, statements, batch };
  }

  test('owner verifies one tenant account, stores its bot identity, and configures the shared webhook', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    lineClientMocks.request
      .mockResolvedValueOnce({ data: { userId: 'U123' } })
      .mockResolvedValueOnce({ data: {} });
    const { db, statements, batch } = connectionDb();

    const res = await setupApp('owner', db).request('/api/line-accounts/acc-1/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getLineAccountByIdForTenant).toHaveBeenCalledWith(db, 'tenant-a', 'acc-1');
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      db,
      'synthetic-line-credential-root-v1',
      { tenantId: 'tenant-a', lineAccountId: 'acc-1', kind: 'channel_access_token' },
    );
    expect(lineClientMocks.request).toHaveBeenNthCalledWith(1, 'GET', '/v2/bot/info');
    expect(lineClientMocks.request).toHaveBeenNthCalledWith(
      2,
      'PUT',
      '/v2/bot/channel/webhook/endpoint',
      { endpoint: 'https://api.example.test/webhook' },
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(statements.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('pharmacy_line_channel_identities'),
      expect.stringContaining('pharmacy_growth_events'),
    ]));
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        lineAccountId: 'acc-1',
        identityRegistered: true,
        webhookConfigured: true,
        webhookUrl: 'https://api.example.test/webhook',
      },
    });
  });

  test('never calls LINE or D1 for an account outside the authenticated tenant', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(null);
    const { db, batch } = connectionDb();

    const res = await setupApp('owner', db).request('/api/line-accounts/foreign/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(lineClientMocks.request).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  test('rejects an invalid token response before storing an identity', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    lineClientMocks.request.mockResolvedValueOnce({ data: { displayName: 'No identity' } });
    const { db, batch } = connectionDb();

    const res = await setupApp('owner', db).request('/api/line-accounts/acc-1/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
    expect(lineClientMocks.request).toHaveBeenCalledTimes(1);
  });

  test('fails closed on a bot identity collision and leaves the webhook unchanged', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    lineClientMocks.request.mockResolvedValueOnce({ data: { userId: 'UalreadyOwned' } });
    const { db } = connectionDb(new Error('UNIQUE constraint failed: pharmacy_line_channel_identities.bot_user_id'));

    const res = await setupApp('owner', db).request('/api/line-accounts/acc-1/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    expect(lineClientMocks.request).toHaveBeenCalledTimes(1);
  });

  test('reports a retryable partial result when LINE rejects webhook configuration', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    lineClientMocks.request
      .mockResolvedValueOnce({ data: { userId: 'U123' } })
      .mockRejectedValueOnce(new Error('LINE request failed'));
    const { db } = connectionDb();

    const res = await setupApp('owner', db).request('/api/line-accounts/acc-1/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      data: { identityRegistered: true, webhookConfigured: false },
    });
  });

  test('does not allow an admin to reconfigure LINE credentials', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    const { db } = connectionDb();

    const res = await setupApp('admin', db).request('/api/line-accounts/acc-1/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect(lineClientMocks.request).not.toHaveBeenCalled();
  });

  test('does not call LINE when the encrypted account token is unavailable', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    credentialMocks.readLineCredential.mockResolvedValue(null);
    const { db, batch } = connectionDb();

    const res = await setupApp('owner', db).request('/api/line-accounts/acc-1/connect', {
      method: 'POST',
    });

    expect(res.status).toBe(503);
    expect(lineClientMocks.request).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('GET /api/line-accounts', () => {
  test('exposes pharmacy mode without exposing account secrets', async () => {
    dbMocks.getLineAccountsForTenant.mockResolvedValue([fakeAccount]);
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            sql.includes('SELECT mode FROM pharmacy_account_capabilities')
              ? { mode: 'pharmacy' }
              : sql.includes('pharmacy_account_capabilities')
                ? { pharmacy_install: 1 }
                : { count: 0 },
          ),
          all: vi.fn().mockResolvedValue({ results: [{ line_account_id: 'acc-1' }] }),
        })),
      })),
    } as unknown as D1Database;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await setupApp('owner', db).request('/api/line-accounts');
    const body = await res.json() as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(dbMocks.getLineAccountsForTenant).toHaveBeenCalledWith(db, 'tenant-a');
    expect(body.data[0]).toMatchObject({ id: 'acc-1', pharmacyMode: true });
    expect(body.data[0]).not.toHaveProperty('channelAccessToken');
    expect(body.data[0]).not.toHaveProperty('channelSecret');
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      db,
      'synthetic-line-credential-root-v1',
      { tenantId: 'tenant-a', lineAccountId: 'acc-1', kind: 'channel_access_token' },
    );
    fetchMock.mockRestore();
  });

  test('hides pharmacy accounts not assigned to the authenticated staff member', async () => {
    const secondAccount = { ...fakeAccount, id: 'acc-2', name: '別店舗' };
    dbMocks.getLineAccountsForTenant.mockResolvedValue([fakeAccount, secondAccount]);
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            sql.includes('SELECT mode FROM pharmacy_account_capabilities')
              ? { mode: 'pharmacy' }
              : sql.includes('pharmacy_account_capabilities')
                ? { pharmacy_install: 1 }
                : { count: 0 },
          ),
          all: vi.fn().mockResolvedValue({ results: [{ line_account_id: 'acc-1' }] }),
        })),
      })),
    } as unknown as D1Database;

    const res = await setupApp('staff', db).request('/api/line-accounts');
    const body = await res.json() as { data: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(body.data.map(({ id }) => id)).toEqual(['acc-1']);
  });
});

describe('GET /api/line-accounts/:id', () => {
  test('never returns stored LINE credentials, including to an owner', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_secret: 'login-secret',
    });

    const res = await setupApp('owner').request('/api/line-accounts/acc-1');
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).not.toHaveProperty('channelAccessToken');
    expect(body.data).not.toHaveProperty('channelSecret');
    expect(body.data).not.toHaveProperty('loginChannelSecret');
  });
});

describe('GET /api/line-accounts/:id/follower-insight', () => {
  test('returns LINE follower insight without exposing account token', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    lineClientMocks.getFollowersInsight.mockResolvedValue({
      status: 'ready',
      followers: 123,
      targetedReaches: 111,
      blocks: 4,
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1/follower-insight?date=20260616');

    expect(res.status).toBe(200);
    expect(dbMocks.getLineAccountByIdForTenant).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'acc-1',
    );
    expect(lineClientMocks.getFollowersInsight).toHaveBeenCalledWith('20260616');
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-v1',
      { tenantId: 'tenant-a', lineAccountId: 'acc-1', kind: 'channel_access_token' },
    );
    const body = (await res.json()) as {
      success: boolean;
      data: {
        lineAccountId: string;
        date: string;
        status: string;
        followers: number;
        targetedReaches: number;
        blocks: number;
        channelAccessToken?: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      lineAccountId: 'acc-1',
      date: '20260616',
      status: 'ready',
      followers: 123,
      targetedReaches: 111,
      blocks: 4,
    });
    expect(body.data.channelAccessToken).toBeUndefined();
  });

  test('does not resolve an account outside the authenticated tenant', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(null);

    const res = await setupApp('owner').request(
      '/api/line-accounts/other-tenant-account/follower-insight?date=20260616',
    );

    expect(res.status).toBe(404);
    expect(lineClientMocks.getFollowersInsight).not.toHaveBeenCalled();
  });

  test('denies an unassigned same-tenant account before reading credentials or LINE', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);

    const res = await setupApp('staff').request(
      '/api/line-accounts/acc-2/follower-insight?date=20260616',
    );

    expect(res.status).toBe(403);
    expect(boundaryMocks.accountResourceOwnedByStaff).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'acc-2',
    );
    expect(dbMocks.getLineAccountByIdForTenant).not.toHaveBeenCalled();
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(lineClientMocks.getFollowersInsight).not.toHaveBeenCalled();
  });

  test('rejects missing insight date', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1/follower-insight');

    expect(res.status).toBe(400);
    expect(lineClientMocks.getFollowersInsight).not.toHaveBeenCalled();
  });

});

describe('POST /api/line-accounts', () => {
  test('passes loginChannelId / loginChannelSecret / liffId to atomic account creation', async () => {
    atomicAccountMocks.createEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'login-secret',
      liff_id: '2009624792-XXXX',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
      }),
    });

    expect(res.status).toBe(201);
    expect(atomicAccountMocks.createEncryptedLineAccount).toHaveBeenCalledTimes(1);
    expect(atomicAccountMocks.createEncryptedLineAccount.mock.calls[0][2]).toMatchObject({
      tenantId: 'tenant-a',
      channelId: '123456789',
      loginChannelId: '2009624792',
      liffId: '2009624792-XXXX',
      credentials: [
        { kind: 'channel_access_token', credential: 'token' },
        { kind: 'channel_secret', credential: 'secret' },
        { kind: 'login_channel_secret', credential: 'login-secret' },
      ],
    });

    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.loginChannelId).toBe('2009624792');
    expect(body.data.liffId).toBe('2009624792-XXXX');
    expect(body.data).not.toHaveProperty('channelAccessToken');
    expect(body.data).not.toHaveProperty('channelSecret');
    expect(body.data).not.toHaveProperty('loginChannelSecret');
  });

  test('omits loginChannelId/etc when not provided (stores null)', async () => {
    atomicAccountMocks.createEncryptedLineAccount.mockResolvedValue(fakeAccount);

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
      }),
    });

    expect(res.status).toBe(201);
    expect(atomicAccountMocks.createEncryptedLineAccount.mock.calls[0][2]).toMatchObject({
      loginChannelId: null,
      liffId: null,
    });
  });

  test('rejects tenant-side account creation for a pharmacy tenant', async () => {
    const app = setupApp('owner', makePharmacyDbStub());
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        loginChannelSecret: 'login-secret',
        liffId: '2009624792-XXXX',
      }),
    });

    expect(res.status).toBe(403);
    expect(atomicAccountMocks.createEncryptedLineAccount).not.toHaveBeenCalled();
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/platform-managed/),
    });
  });

  test('trims whitespace and treats empty string as null for optional fields', async () => {
    atomicAccountMocks.createEncryptedLineAccount.mockResolvedValue(fakeAccount);

    // Use a complete login pair (both id+secret present) to focus on the
    // trim/empty-string normalization behavior. liffId is independent.
    const app = setupApp('owner');
    await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '  2009624792  ',
        loginChannelSecret: '  login-secret  ',
        liffId: '   ',
      }),
    });

    expect(atomicAccountMocks.createEncryptedLineAccount.mock.calls[0][2]).toMatchObject({
      loginChannelId: '2009624792',
      liffId: null,
    });
    expect(atomicAccountMocks.createEncryptedLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-v1',
      expect.objectContaining({
        credentials: expect.arrayContaining([
          { kind: 'login_channel_secret', credential: 'login-secret' },
        ]),
      }),
    );
  });
});

describe('PATCH /api/line-accounts/:id', () => {
  test('updates loginChannelId / loginChannelSecret / liffId via metadata path', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      liff_id: '2009999999-YYYY',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009999999',
        loginChannelSecret: 'rotated',
        liffId: '2009999999-YYYY',
      }),
    });

    expect(res.status).toBe(200);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalledTimes(1);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-v1',
      expect.objectContaining({
        tenantId: 'tenant-a',
        lineAccountId: 'acc-1',
        credentials: [{ kind: 'login_channel_secret', credential: 'rotated' }],
        metadata: expect.objectContaining({
          loginChannelId: '2009999999',
          liffId: '2009999999-YYYY',
        }),
      }),
    );
  });

  test('clears LIFF when explicitly set to empty string', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      liff_id: null,
    });

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '' }),
    });

    expect(atomicAccountMocks.updateEncryptedLineAccount.mock.calls[0][2].metadata).toMatchObject({
      liffId: null,
    });
  });

  test('does not allow a pharmacy account to clear LIFF wiring', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      login_channel_secret: 'encrypted:v1',
      liff_id: '2009999999-YYYYYYYY',
    });

    const res = await setupApp('admin', makePharmacyDbStub()).request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '' }),
    });

    expect(res.status).toBe(400);
    expect(atomicAccountMocks.updateEncryptedLineAccount).not.toHaveBeenCalled();
    expect(((await res.json()) as { error: string }).error).toMatch(/LINE Login channel and LIFF ID/);
  });

  test('can update pharmacy LIFF wiring when the Login secret is encrypted', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      login_channel_secret: 'encrypted:v1',
      liff_id: '2009999999-OLDVALUE',
    });

    const res = await setupApp('admin', makePharmacyDbStub()).request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '2009999999-NEWVALUE' }),
    });

    expect(res.status).toBe(200);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-v1',
      { tenantId: 'tenant-a', lineAccountId: 'acc-1', kind: 'login_channel_secret' },
    );
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalled();
  });

  test('does not reuse a legacy plaintext Login secret for a pharmacy LIFF update', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      login_channel_secret: 'legacy-plaintext-secret',
      liff_id: '2009999999-OLDVALUE',
    });

    const res = await setupApp('admin', makePharmacyDbStub()).request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '2009999999-NEWVALUE' }),
    });

    expect(res.status).toBe(400);
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(atomicAccountMocks.updateEncryptedLineAccount).not.toHaveBeenCalled();
    expect(((await res.json()) as { error: string }).error).toMatch(/encrypted credential/i);
  });

  test('does not touch login/liff fields when not provided', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);

    const app = setupApp('admin');
    await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: '日本' }),
    });

    const arg = atomicAccountMocks.updateEncryptedLineAccount.mock.calls[0][2].metadata;
    expect(arg.country).toBe('日本');
    expect(arg.loginChannelId).toBeUndefined();
    expect(arg.liffId).toBeUndefined();
  });

  test('does not update metadata for an account outside the authenticated tenant', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(null);

    const res = await setupApp('admin').request('/api/line-accounts/foreign-account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: '日本' }),
    });

    expect(res.status).toBe(404);
    expect(atomicAccountMocks.updateEncryptedLineAccount).not.toHaveBeenCalled();
  });
});

describe('Login pair / uniqueness validation', () => {
  test('POST: rejects loginChannelId without secret', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelId: '2009624792',
        // loginChannelSecret missing
      }),
    });

    expect(res.status).toBe(400);
    expect(atomicAccountMocks.createEncryptedLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/loginChannelSecret/);
  });

  test('POST: rejects loginChannelSecret without ID', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        loginChannelSecret: 'orphan',
      }),
    });

    expect(res.status).toBe(400);
    expect(atomicAccountMocks.createEncryptedLineAccount).not.toHaveBeenCalled();
  });

  test('POST: rejects duplicate liffId', async () => {
    // makeDbStub returns "another row already has this liff_id"
    const app = setupApp('owner', makeDbStub({ id: 'other-acc' }));

    const res = await app.request('/api/line-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: '123456789',
        name: 'メイン',
        channelAccessToken: 'token',
        channelSecret: 'secret',
        liffId: '2009624792-DUPLICATE',
      }),
    });

    expect(res.status).toBe(409);
    expect(atomicAccountMocks.createEncryptedLineAccount).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toMatch(/already assigned/);
  });

  test('PATCH: LIFF-only edit succeeds against half-configured Login (id-only) account', async () => {
    // Setup CLI persists login_channel_id without secret as a best-effort.
    // Adding a LIFF ID later via the dashboard must NOT trip the pair check
    // because the request doesn't touch the Login fields at all.
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
    });
    atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'setup-cli-id',
      login_channel_secret: null,
      liff_id: '2009624792-NEW',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '2009624792-NEW' }),
    });

    expect(res.status).toBe(200);
    expect(atomicAccountMocks.updateEncryptedLineAccount.mock.calls[0][2].metadata).toMatchObject({
      liffId: '2009624792-NEW',
    });
  });

  test('PATCH: clearing both Login fields together succeeds', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });
    atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: null,
      login_channel_secret: null,
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null, loginChannelSecret: null }),
    });

    expect(res.status).toBe(200);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-v1',
      expect.objectContaining({
        credentials: [{ kind: 'login_channel_secret', credential: null }],
        metadata: expect.objectContaining({ loginChannelId: null }),
      }),
    );
  });

  test('PATCH: clearing only loginChannelId is rejected (would orphan the secret)', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'old-secret',
    });

    const app = setupApp('admin');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: null }),
    });

    expect(res.status).toBe(400);
    expect(atomicAccountMocks.updateEncryptedLineAccount).not.toHaveBeenCalled();
  });

  test('PATCH: keeps existing secret when only changing the loginChannelId', async () => {
    // Current row already has both id+secret. Caller changes only the id —
    // pair check should pass because the unchanged secret keeps the pair complete.
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'old-id',
      login_channel_secret: 'kept-secret',
    });
    atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: 'new-id',
      login_channel_secret: 'kept-secret',
    });

    const app = setupApp('admin');

    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginChannelId: 'new-id' }),
    });

    expect(res.status).toBe(200);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalled();
  });
});

describe('PUT /api/line-accounts/:id', () => {
  test('rotates Messaging credentials in encrypted storage without writing plaintext metadata', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    const res = await setupApp('owner').request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelAccessToken: `token-${'a'.repeat(64)}`,
        channelSecret: 'a'.repeat(32),
      }),
    });

    expect(res.status).toBe(200);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalledTimes(1);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-v1',
      expect.objectContaining({
        tenantId: 'tenant-a',
        lineAccountId: 'acc-1',
        expectedUpdatedAt: fakeAccount.updated_at,
        credentials: [
          { kind: 'channel_access_token', credential: `token-${'a'.repeat(64)}` },
          { kind: 'channel_secret', credential: 'a'.repeat(32) },
        ],
      }),
    );
  });

  test('does not update account metadata when an atomic credential rotation fails', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    atomicAccountMocks.updateEncryptedLineAccount.mockRejectedValue(new Error('batch failed'));

    const res = await setupApp('owner').request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelAccessToken: `token-${'b'.repeat(64)}`,
        channelSecret: 'b'.repeat(32),
      }),
    });

    expect(res.status).toBe(500);
    expect(atomicAccountMocks.updateEncryptedLineAccount).toHaveBeenCalledTimes(1);
  });

  test('returns conflict when another credential update wins the race', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);
    atomicAccountMocks.updateEncryptedLineAccount.mockRejectedValue(
      new Error(atomicAccountMocks.LINE_ACCOUNT_CONFLICT_ERROR),
    );

    const res = await setupApp('owner').request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelAccessToken: `token-${'c'.repeat(64)}`,
        channelSecret: 'c'.repeat(32),
      }),
    });

    expect(res.status).toBe(409);
  });

  test('owner can update Login/LIFF + country/role in one request', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_secret: 'existing-secret',
    });
    atomicAccountMocks.updateEncryptedLineAccount.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009624792',
      login_channel_secret: 'existing-secret',
      liff_id: '2009624792-XXXX',
    });

    const app = setupApp('owner');
    const res = await app.request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginChannelId: '2009624792',
        liffId: '2009624792-XXXX',
        country: '日本',
        role: '本店',
      }),
    });

    expect(res.status).toBe(200);
    expect(atomicAccountMocks.updateEncryptedLineAccount.mock.calls[0][2].metadata).toMatchObject({
      loginChannelId: '2009624792',
      liffId: '2009624792-XXXX',
      country: '日本',
      role: '本店',
    });
  });

  test('does not allow a pharmacy owner to clear LIFF wiring', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue({
      ...fakeAccount,
      login_channel_id: '2009999999',
      login_channel_secret: 'encrypted:v1',
      liff_id: '2009999999-YYYYYYYY',
    });

    const res = await setupApp('owner', makePharmacyDbStub()).request('/api/line-accounts/acc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liffId: '' }),
    });

    expect(res.status).toBe(400);
    expect(atomicAccountMocks.updateEncryptedLineAccount).not.toHaveBeenCalled();
  });
});

describe('tenant-scoped mutations', () => {
  test('rejects bulk order changes containing an account from another tenant', async () => {
    dbMocks.getLineAccountsForTenant.mockResolvedValue([fakeAccount]);

    const res = await setupApp('admin').request('/api/line-accounts/order', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ordered: [
          { id: 'acc-1', displayOrder: 0 },
          { id: 'foreign-account', displayOrder: 1 },
        ],
      }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.updateLineAccountOrder).not.toHaveBeenCalled();
  });

  test('does not delete an account outside the authenticated tenant', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(null);

    const res = await setupApp('owner').request('/api/line-accounts/foreign-account', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect(dbMocks.deleteLineAccount).not.toHaveBeenCalled();
  });

  test('rejects tenant-side account deletion for a pharmacy tenant', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(fakeAccount);

    const res = await setupApp('owner', makePharmacyDbStub()).request('/api/line-accounts/acc-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    expect(dbMocks.deleteLineAccount).not.toHaveBeenCalled();
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/platform-managed/),
    });
  });
});
