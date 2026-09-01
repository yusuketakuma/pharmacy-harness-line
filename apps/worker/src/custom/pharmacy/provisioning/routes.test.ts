import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';

const migrationMocks = vi.hoisted(() => ({
  backfillLineCredentials: vi.fn(),
  restoreLegacyLineCredentials: vi.fn(),
  scrubLegacyLineCredentials: vi.fn(),
  backfillPatientIntakeEnvelopes: vi.fn(),
  inspectPatientIntakeCoverage: vi.fn(),
  freezePatientIntakeWrites: vi.fn(),
  restorePatientIntakeLegacyFields: vi.fn(),
  scrubPatientIntakeLegacyFields: vi.fn(),
}));
vi.mock('./line-credential-backfill.js', () => migrationMocks);
vi.mock('../intake/migration.js', () => migrationMocks);

import { tenantProvisioningRoutes } from './routes.js';

type Statement = {
  sql: string;
  values: unknown[];
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
};

function fakeDb() {
  const batches: Statement[][] = [];
  let receipt: Record<string, unknown> | null = null;
  return {
    db: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement: Statement = {
          sql,
          values,
          first: async <T>() => {
            if (!sql.includes('FROM pharmacy_tenant_provisioning_requests')) return null;
            if (!receipt || receipt.idempotency_key !== values[0]) return null;
            return receipt as T;
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
        const provision = statements.find((statement) =>
          statement.sql.includes('INSERT INTO pharmacy_tenant_provisioning_requests'));
        const tenant = statements.find((statement) => statement.sql.includes('INSERT INTO tenants'));
        const account = statements.find((statement) => statement.sql.includes('INSERT INTO line_accounts'));
        const staff = statements.find((statement) => statement.sql.includes('INSERT INTO staff_members'));
        const credential = statements.find((statement) =>
          statement.sql.includes('INSERT INTO tenant_admin_credentials'));
        if (provision && tenant && account && staff && credential) {
          receipt = {
            idempotency_key: provision.values[0],
            request_hash: provision.values[1],
            tenant_id: tenant.values[0],
            line_account_id: account.values[0],
            staff_id: staff.values[0],
            tenant_code: tenant.values[1],
            display_name: tenant.values[2],
            login_id: credential.values[2],
            line_account_name: account.values[2],
            liff_id: account.values[7],
          };
        }
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } as unknown as D1Database,
    batches,
  };
}

const requestBody = {
  tenantCode: 'pharmacy-a',
  tenantName: 'Pharmacy A',
  admin: {
    loginId: 'admin-a',
    displayName: 'Owner A',
    email: 'owner@example.test',
    temporaryPassword: 'Temporary pass 42',
  },
  line: {
    channelId: '2001234567',
    displayName: 'Pharmacy A LINE',
    channelAccessToken: 'synthetic.line.access-token_with-enough-length.1234567890',
    channelSecret: '0123456789abcdef0123456789abcdef',
    loginChannelId: '2007654321',
    loginChannelSecret: 'abcdef0123456789abcdef0123456789',
    liffId: '2007654321-AbCdEfGh',
  },
};

function bindings(db: D1Database, overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: db,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    API_KEY: 'legacy-key',
    PLATFORM_ADMIN_KEY: 'platform-key',
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-token-key-for-tests',
    LINE_CREDENTIAL_KEY_V1: 'line-credential-root-key-for-tests-v1',
    PHARMACY_PHI_KEY_V1: 'pharmacy-phi-root-key-for-tests-v1',
    LINE_CHANNEL_SECRET: 'default-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'default-token',
    LIFF_URL: 'https://liff.line.me/default',
    LINE_CHANNEL_ID: 'default-channel',
    LINE_LOGIN_CHANNEL_ID: 'default-login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'default-login-secret',
    WORKER_URL: 'https://api.example.test',
    WORKER_PUBLIC_URL: 'https://api.example.test',
    ADMIN_PUBLIC_URL: 'https://admin.example.test',
    LIFF_PUBLIC_URL: 'https://liff.example.test',
    ...overrides,
  };
}

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', tenantProvisioningRoutes);
  return instance;
}

function platformApp(db: D1Database): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('platformAdmin', { id: 'platform-admin-1', name: 'Platform Owner' });
    await next();
  });
  instance.route('/', tenantProvisioningRoutes);
  return instance;
}

function request(body = requestBody, key = 'setup-request-123') {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer platform-key',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  };
}

afterEach(() => {
  // vitest 4 narrows restoreAllMocks to vi.spyOn spies (needed to restore the real
  // globalThis.fetch); plain vi.hoisted(() => ({ ...: vi.fn() })) mocks like
  // migrationMocks/credentialMocks now need clearAllMocks to drop call history too.
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('platform tenant provisioning', () => {
  it('allows only an authenticated platform admin to use the browser provisioning route', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app().request('/api/platform-admin/tenants', {
      method: 'POST', headers: { origin: 'https://admin.example.test', 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }, bindings(fake.db));

    expect(response.status).toBe(401);
    expect(fake.batches).toHaveLength(0);
    expect(lineFetch).not.toHaveBeenCalled();
  });

  it('reuses the atomic provisioning transaction and audit for the platform-admin wizard', async () => {
    const fake = fakeDb();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'U123' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const response = await platformApp(fake.db).request('/api/platform-admin/tenants', {
      method: 'POST',
      headers: {
        origin: 'https://admin.example.test',
        'content-type': 'application/json',
        'idempotency-key': 'browser-setup-123',
      },
      body: JSON.stringify(requestBody),
    }, bindings(fake.db));

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(requestBody.admin.temporaryPassword);
    expect(text).not.toContain(requestBody.line.channelAccessToken);
    expect(text).not.toContain(requestBody.line.channelSecret);
    expect(text).not.toContain(requestBody.line.loginChannelSecret);
    expect(fake.batches[0].some(({ sql, values }) =>
      sql.includes('platform_admin_access_events') && values.includes('platform-admin-1') &&
      values.includes('tenant_provision'))).toBe(true);
  });

  it('fails closed when the platform key is missing or wrong', async () => {
    const fake = fakeDb();
    const noSecret = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db, { PLATFORM_ADMIN_KEY: undefined }),
    );
    expect(noSecret.status).toBe(503);

    const wrongKey = await app().request('/api/platform/pharmacy/tenants', {
      ...request(),
      headers: { ...request().headers, authorization: 'Bearer wrong-key' },
    }, bindings(fake.db));
    expect(wrongKey.status).toBe(401);
    expect(fake.batches).toHaveLength(0);
  });

  it('rejects a LIFF ID that does not belong to the submitted login channel', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request({
        ...requestBody,
        line: { ...requestBody.line, liffId: '2999999999-AbCdEfGh' },
      }),
      bindings(fake.db),
    );

    expect(response.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(fake.batches).toHaveLength(0);
  });

  it('rejects incomplete LINE Login channel credentials before calling LINE', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request({
        ...requestBody,
        line: { ...requestBody.line, loginChannelSecret: null as unknown as string },
      }),
      bindings(fake.db),
    );

    expect(response.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(fake.batches).toHaveLength(0);
  });

  it('rejects a pharmacy setup without the LINE Login and LIFF identifiers', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request({
        ...requestBody,
        line: {
          ...requestBody.line,
          loginChannelId: null as unknown as string,
          loginChannelSecret: null as unknown as string,
          liffId: null as unknown as string,
        },
      }),
      bindings(fake.db),
    );

    expect(response.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(fake.batches).toHaveLength(0);
  });

  it('atomically creates a tenant login and account, then configures the LINE webhook', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'U123', displayName: 'Pharmacy A' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db),
    );

    expect(response.status).toBe(201);
    const body = await response.json() as {
      data: Record<string, unknown> & { urls: Record<string, string>; line: Record<string, unknown> };
    };
    expect(body.data).toMatchObject({
      adminLoginId: 'admin-a',
      replayed: false,
      line: { tokenValidated: true, webhookConfigured: true },
    });
    expect(body.data.tenantCode).toMatch(/^\d{6}$/);
    expect(body.data.urls).toMatchObject({
      admin: 'https://admin.example.test',
      webhook: 'https://api.example.test/webhook',
      liffEndpoint: 'https://liff.example.test/?liffId=2007654321-AbCdEfGh',
    });
    expect(body.data.urls).not.toHaveProperty('callback');

    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0].map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO tenants'),
      expect.stringContaining('INSERT INTO line_accounts'),
      expect.stringContaining('INSERT INTO pharmacy_line_credentials'),
      expect.stringContaining('INSERT INTO tenant_line_accounts'),
      expect.stringContaining('INSERT INTO pharmacy_line_channel_identities'),
      expect.stringContaining('INSERT OR IGNORE INTO pharmacy_account_capabilities'),
      expect.stringContaining('INSERT INTO staff_members'),
      expect.stringContaining('INSERT INTO tenant_staff_memberships'),
      expect.stringContaining('INSERT INTO tenant_admin_credentials'),
      expect.stringContaining('INSERT INTO pharmacy_tenant_admin_bootstraps'),
      expect.stringContaining('INSERT INTO pharmacy_tenant_provisioning_requests'),
    ]));
    const capabilityInsert = fake.batches[0].find(({ sql }) =>
      sql.includes('INSERT OR IGNORE INTO pharmacy_account_capabilities'));
    expect(capabilityInsert).toBeDefined();
    const storedCapabilities = capabilityInsert?.values.find((value) =>
      typeof value === 'string' && value.includes('emergency_contraception'));
    expect(storedCapabilities).toEqual(expect.stringContaining('emergency_contraception'));
    expect(storedCapabilities).not.toContain('electronic_prescription');
    const storedValues = fake.batches[0].flatMap(({ values }) => values);
    expect(storedValues).not.toContain(requestBody.admin.temporaryPassword);
    expect(storedValues).not.toContain(requestBody.line.channelAccessToken);
    expect(storedValues).not.toContain(requestBody.line.channelSecret);
    expect(storedValues).not.toContain(requestBody.line.loginChannelSecret);
    expect(storedValues.some((value) =>
      typeof value === 'string' && value.startsWith('pbkdf2-sha256$'))).toBe(true);
    const staffInsert = fake.batches[0].find(({ sql }) => sql.includes('INSERT INTO staff_members'));
    expect(staffInsert?.values[3]).toMatch(/^disabled:/);

    expect(lineFetch).toHaveBeenNthCalledWith(1, 'https://api.line.me/v2/bot/info', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: `Bearer ${requestBody.line.channelAccessToken}` }),
    }));
    expect(lineFetch).toHaveBeenNthCalledWith(2, 'https://api.line.me/v2/bot/channel/webhook/endpoint', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ endpoint: 'https://api.example.test/webhook' }),
    }));
  });

  it('replays the same request once and rejects an idempotency-key payload mismatch', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ userId: 'U123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const first = await app().request(
      '/api/platform/pharmacy/tenants', request(), bindings(fake.db),
    );
    expect(first.status).toBe(201);

    const replay = await app().request(
      '/api/platform/pharmacy/tenants', request(), bindings(fake.db),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ data: { replayed: true } });
    expect(fake.batches).toHaveLength(1);
    expect(lineFetch).toHaveBeenCalledTimes(2);

    const mismatch = await app().request(
      '/api/platform/pharmacy/tenants',
      request({ ...requestBody, tenantName: 'Changed name' }),
      bindings(fake.db),
    );
    expect(mismatch.status).toBe(409);
    expect(fake.batches).toHaveLength(1);

    // A retried CLI run sends a fresh random password; only the password may differ.
    const retried = await app().request(
      '/api/platform/pharmacy/tenants',
      request({ ...requestBody, admin: { ...requestBody.admin, temporaryPassword: 'Other password 99' } }),
      bindings(fake.db),
    );
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ data: { replayed: true } });
    expect(fake.batches).toHaveLength(1);
  });

  it('rejects browser-origin and malformed setup data before using LINE or D1', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const browser = await app().request('/api/platform/pharmacy/tenants', {
      ...request(),
      headers: { ...request().headers, origin: 'https://admin.example.test' },
    }, bindings(fake.db));
    expect(browser.status).toBe(403);

    const invalid = await app().request(
      '/api/platform/pharmacy/tenants',
      request({ ...requestBody, admin: { ...requestBody.admin, loginId: '../other' } }),
      bindings(fake.db),
    );
    expect(invalid.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(fake.batches).toHaveLength(0);
  });

  // The pharmacy code is the tenant selector a pharmacist types at login, so it is
  // server-assigned rather than caller-chosen: an operator can no longer hand two
  // pharmacies confusable codes, and a caller cannot squat a code it does not own.
  it('assigns a 6-digit pharmacy code and ignores any caller-supplied one', async () => {
    const fake = fakeDb();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ userId: 'Ubot' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request({ ...requestBody, tenantCode: 'attacker-chosen-code' }),
      bindings(fake.db),
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { data: { tenantCode: string } };
    expect(body.data.tenantCode).toMatch(/^\d{6}$/);
    expect(body.data.tenantCode).not.toBe('attacker-chosen-code');

    const stored = fake.batches[0]
      .find(({ sql }) => sql.includes('INSERT INTO tenants'))?.values[1];
    expect(stored).toBe(body.data.tenantCode);
  });

  // A replay must return the code assigned on the first attempt. That only holds if
  // the generated code stays out of requestHash — otherwise every retry hashes a new
  // random value and 409s as "same key, different data".
  it('returns the originally assigned pharmacy code when a request is replayed', async () => {
    const fake = fakeDb();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ userId: 'Ubot' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const first = await app().request(
      '/api/platform/pharmacy/tenants', request(), bindings(fake.db),
    );
    expect(first.status).toBe(201);
    const firstCode = ((await first.json()) as { data: { tenantCode: string } }).data.tenantCode;

    const replay = await app().request(
      '/api/platform/pharmacy/tenants', request(), bindings(fake.db),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      data: { tenantCode: firstCode, replayed: true },
    });
    expect(fake.batches).toHaveLength(1);
  });

  it('rejects a platform key reused as a tenant data-plane key', async () => {
    const fake = fakeDb();
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db, { API_KEY: 'platform-key' }),
    );
    expect(response.status).toBe(503);
    expect(fake.batches).toHaveLength(0);
  });

  it('rejects a platform key reused for cross-account token signing', async () => {
    const fake = fakeDb();
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db, { CROSS_ACCOUNT_TOKEN_KEY: 'platform-key' }),
    );
    expect(response.status).toBe(503);
    expect(fake.batches).toHaveLength(0);
  });

  it('fails closed before LINE or D1 when credential encryption is not configured', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db, { LINE_CREDENTIAL_KEY_V1: undefined }),
    );
    expect(response.status).toBe(503);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(fake.batches).toHaveLength(0);
  });

  it('rejects an invalid credential root before calling LINE', async () => {
    const fake = fakeDb();
    const lineFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db, { LINE_CREDENTIAL_KEY_V1: 'too-short' }),
    );

    expect(response.status).toBe(503);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(fake.batches).toHaveLength(0);
  });

  it('rejects a platform key reused as the LINE credential encryption key', async () => {
    const fake = fakeDb();
    const response = await app().request(
      '/api/platform/pharmacy/tenants',
      request(),
      bindings(fake.db, { LINE_CREDENTIAL_KEY_V1: 'platform-key' }),
    );
    expect(response.status).toBe(503);
    expect(fake.batches).toHaveLength(0);
  });
});

describe('explicit legacy LINE credential migration', () => {
  const endpoint = '/api/platform/pharmacy/tenants/tenant-a/line-accounts/account-a/credentials';

  it.each([
    ['backfill', migrationMocks.backfillLineCredentials, { written: 3, verified: 0 }],
    ['scrub', migrationMocks.scrubLegacyLineCredentials, { scrubbed: true, verified: 3 }],
    ['restore', migrationMocks.restoreLegacyLineCredentials, { restored: true, verified: 3 }],
  ])('runs the authenticated %s phase without returning credentials', async (phase, operation, result) => {
    operation.mockResolvedValue(result);
    const fake = fakeDb();
    const response = await app().request(`${endpoint}/${phase}`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key' },
    }, bindings(fake.db));

    expect(response.status).toBe(200);
    expect(operation).toHaveBeenCalledWith(
      fake.db,
      'line-credential-root-key-for-tests-v1',
      { tenantId: 'tenant-a', lineAccountId: 'account-a' },
    );
    expect(await response.text()).not.toContain(requestBody.line.channelAccessToken);
  });

  it('rejects browser-origin and unauthenticated migration requests before DB mutation', async () => {
    const fake = fakeDb();
    const browser = await app().request(`${endpoint}/backfill`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key', origin: 'https://admin.example.test' },
    }, bindings(fake.db));
    const unauthenticated = await app().request(`${endpoint}/scrub`, {
      method: 'POST',
    }, bindings(fake.db));

    expect(browser.status).toBe(403);
    expect(unauthenticated.status).toBe(401);
    expect(migrationMocks.backfillLineCredentials).not.toHaveBeenCalled();
    expect(migrationMocks.restoreLegacyLineCredentials).not.toHaveBeenCalled();
    expect(migrationMocks.scrubLegacyLineCredentials).not.toHaveBeenCalled();
  });
});

describe('explicit patient intake encryption migration', () => {
  const endpoint = '/api/platform/pharmacy/tenants/tenant-a/line-accounts/account-a/intake-encryption';
  const report = {
    counts: { scanned: 1, verified: 1, inserted: 0, skipped: 0, scrubbed: 0, restored: 0, conflicts: 0 },
    errorCode: null,
    nextCursor: null,
  };

  it('runs a dry-run backfill with tenant/account scope and no PHI response', async () => {
    migrationMocks.backfillPatientIntakeEnvelopes.mockResolvedValue(report);
    const fake = fakeDb();
    const response = await app().request(`${endpoint}/backfill`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key', 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: null, limit: 25, dryRun: false }),
    }, bindings(fake.db));

    expect(response.status).toBe(200);
    expect(migrationMocks.backfillPatientIntakeEnvelopes).toHaveBeenCalledWith(fake.db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      rootSecret: 'pharmacy-phi-root-key-for-tests-v1', cursor: null, limit: 25, dryRun: true,
    });
    expect(await response.json()).toEqual({ success: true, data: report });
  });

  it('requires the PHI key and rejects legacy freeze mutation', async () => {
    const fake = fakeDb();
    const missingKey = await app().request(`${endpoint}/coverage`, {
      method: 'POST', headers: { authorization: 'Bearer platform-key' },
    }, bindings(fake.db, { PHARMACY_PHI_KEY_V1: undefined }));
    expect(missingKey.status).toBe(503);

    const freeze = await app().request(`${endpoint}/freeze`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key', 'content-type': 'application/json' },
      body: '{}',
    }, bindings(fake.db));
    expect(freeze.status).toBe(409);
    expect(migrationMocks.freezePatientIntakeWrites).not.toHaveBeenCalled();
  });

  it('rejects legacy body identity instead of accepting named approval', async () => {
    const fake = fakeDb();
    const approval = {
      approvedBy: 'security-owner', approvalReference: 'TICKET-123',
      coverageTotal: 3, coverageDigest: 'a'.repeat(64),
    };
    const response = await app().request(`${endpoint}/scrub`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-key', 'content-type': 'application/json' },
      body: JSON.stringify({ approval }),
    }, bindings(fake.db));

    expect(response.status).toBe(400);
    expect(migrationMocks.scrubPatientIntakeLegacyFields).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('security-owner');
  });
});
