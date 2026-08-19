import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { toJstString } from '@line-crm/db';
import type { Env } from '../../../index.js';
import {
  generatePlatformAdminSessionToken,
  hashTenantAdminSessionToken,
} from '../provisioning/credentials.js';
import { platformAdminAuthMiddleware } from './auth.js';
import { platformAdminDashboardRoutes } from './dashboard-routes.js';

// These routes are pure aggregate SQL. The hand-rolled fake D1 in
// routes.test.ts answers by matching SQL substrings, which would make a
// "the counts are correct" assertion a tautology, so this file drives the
// real schema through better-sqlite3 — the same adapter shape
// routes/webhook-durable-inbox.test.ts already uses in this app.
const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type Sqlite3Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

const BOOTSTRAP = readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8');

/** Adapts better-sqlite3 to the slice of the D1 surface these routes use. */
function d1From(sqlite: Sqlite3Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => ({
      success: true,
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
      results: [],
    }),
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const START = Date.now();

/** tenant_admin_sessions / grants are written with toISOString(); receipts with jstNow(). */
const utcAgo = (ms: number) => new Date(START - ms).toISOString();
const utcAhead = (ms: number) => new Date(START + ms).toISOString();
const jstAgo = (ms: number) => toJstString(new Date(START - ms));

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('/api/platform-admin/*', platformAdminAuthMiddleware);
  instance.route('/', platformAdminDashboardRoutes);
  return instance;
}

function fresh(foreignKeys: 'ON' | 'OFF'): Sqlite3Database {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma(`foreign_keys = ${foreignKeys}`);
  sqlite.exec(BOOTSTRAP);
  return sqlite;
}

/**
 * Seeds a real platform-admin session so the routes run behind the actual
 * middleware. The password hash is never verified on this path (only the
 * session token is), so no PBKDF2 work is needed here.
 */
async function seedPlatformAdmin(sqlite: Sqlite3Database): Promise<string> {
  const now = utcAgo(0);
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
     VALUES (?, ?, NULL, 'owner', ?, 1, ?, ?)`,
  ).run('staff-platform', 'Platform Owner', 'api-key-platform', now, now);
  sqlite.prepare(
    `INSERT INTO platform_admins (staff_id, granted_by, is_active, created_at, updated_at)
     VALUES (?, NULL, 1, ?, ?)`,
  ).run('staff-platform', now, now);
  sqlite.prepare(
    `INSERT INTO platform_admin_credentials
       (staff_id, login_id, password_hash, must_change_password, credential_version, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).run('staff-platform', 'platform-admin', 'unused-on-the-session-path', now, now);
  const token = generatePlatformAdminSessionToken();
  sqlite.prepare(
    `INSERT INTO platform_admin_sessions
       (token_hash, staff_id, credential_version, session_kind, expires_at, revoked_at, created_at)
     VALUES (?, ?, 1, 'standard', ?, NULL, ?)`,
  ).run(await hashTenantAdminSessionToken(token), 'staff-platform', utcAhead(DAY_MS), now);
  return `lh_platform_admin_session=${token}`;
}

function seedTenant(sqlite: Sqlite3Database, id: string, code: string, status: string): void {
  const now = utcAgo(0);
  sqlite.prepare(
    `INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, code, `Pharmacy ${code}`, status, now, now);
}

function seedAccount(sqlite: Sqlite3Database, tenantId: string, id: string, isActive: number): void {
  const now = utcAgo(0);
  sqlite.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `channel-${id}`, `Account ${id}`, `token-${id}`, `secret-${id}`, isActive, now, now);
  sqlite.prepare(
    `INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(tenantId, id, now, now);
}

function seedReceipt(
  sqlite: Sqlite3Database,
  tenantId: string,
  accountId: string,
  eventId: string,
  receivedAt: string,
  status: string,
  deadLetteredAt: string | null = null,
): void {
  sqlite.prepare(
    `INSERT INTO pharmacy_webhook_event_receipts
       (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count, dead_lettered_at)
     VALUES (?, ?, ?, ?, NULL, ?, 0, ?)`,
  ).run(tenantId, accountId, eventId, receivedAt, status, deadLetteredAt);
}

function seedMembership(sqlite: Sqlite3Database, tenantId: string, staffId: string, isActive: number): void {
  const now = utcAgo(0);
  sqlite.prepare(
    `INSERT OR IGNORE INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
     VALUES (?, ?, NULL, 'staff', ?, 1, ?, ?)`,
  ).run(staffId, staffId, `api-key-${staffId}`, now, now);
  sqlite.prepare(
    `INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active, created_at, updated_at)
     VALUES (?, ?, 'staff', ?, ?, ?)`,
  ).run(tenantId, staffId, isActive, now, now);
}

function seedTenantSession(
  sqlite: Sqlite3Database,
  tenantId: string,
  staffId: string,
  tokenSuffix: string,
  createdAt: string,
  expiresAt: string,
  revokedAt: string | null = null,
): void {
  sqlite.prepare(
    `INSERT INTO tenant_admin_sessions
       (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, 1, 'standard', ?, ?, ?)`,
  ).run(tokenSuffix.padStart(64, '0'), tenantId, staffId, expiresAt, revokedAt, createdAt);
}

function seedGrant(
  sqlite: Sqlite3Database,
  id: string,
  tenantId: string,
  expiresAt: string,
  revokedAt: string | null = null,
): void {
  const now = utcAgo(0);
  sqlite.prepare(
    `INSERT INTO platform_admin_access_grants
       (id, platform_admin_id, tenant_id, scopes, reason, ticket_reference,
        reauth_verified_at, issued_at, expires_at, revoked_at, revoked_by)
     VALUES (?, 'staff-platform', ?, '["phi:read"]', 'support', NULL, ?, ?, ?, ?, NULL)`,
  ).run(id, tenantId, now, now, expiresAt, revokedAt);
}

function accessEvents(sqlite: Sqlite3Database) {
  return sqlite.prepare(
    `SELECT platform_admin_id, tenant_id, action, resource_type, resource_id, detail_json
       FROM platform_admin_access_events ORDER BY created_at, rowid`,
  ).all() as Array<Record<string, unknown>>;
}

// Mirrors the audit-coverage guard in routes.test.ts: a route added to this
// router without an access event is a compliance regression, so a new route
// must fail here until it is given one (and a test above proving it).
it('registers only routes whose access events are asserted in this file', () => {
  expect(new Set(platformAdminDashboardRoutes.routes.map((route) => `${route.method} ${route.path}`)))
    .toEqual(new Set([
      'GET /api/platform-admin/dashboard',
      'GET /api/platform-admin/tenants/:id/health',
      'GET /api/platform-admin/integrity',
    ]));
});

describe('platform admin dashboard aggregate', () => {
  let sqlite: Sqlite3Database;
  let cookie: string;
  let testEnv: Env['Bindings'];

  beforeEach(async () => {
    sqlite = fresh('ON');
    cookie = await seedPlatformAdmin(sqlite);
    testEnv = { DB: d1From(sqlite) } as unknown as Env['Bindings'];

    seedTenant(sqlite, 'tenant-a', 'pharmacy-a', 'active');
    seedTenant(sqlite, 'tenant-b', 'pharmacy-b', 'suspended');
    seedTenant(sqlite, 'tenant-c', 'pharmacy-c', 'active');
    seedAccount(sqlite, 'tenant-a', 'account-a', 1);
    seedAccount(sqlite, 'tenant-b', 'account-b', 1);

    // Failures inside the window (one plain failure, one dead-lettered) plus
    // one outside it that must not be counted.
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'fail-recent', jstAgo(2 * HOUR_MS), 'failed');
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'dead-recent', jstAgo(3 * HOUR_MS), 'completed', utcAgo(3 * HOUR_MS));
    seedReceipt(sqlite, 'tenant-b', 'account-b', 'fail-old', jstAgo(48 * HOUR_MS), 'failed');
    // Backlog is age-independent: an ancient pending row is the worst kind.
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'pending-new', jstAgo(5 * 60 * 1000), 'pending');
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'pending-old', jstAgo(72 * HOUR_MS), 'pending');
    seedReceipt(sqlite, 'tenant-b', 'account-b', 'processing', jstAgo(HOUR_MS), 'processing');
    seedReceipt(sqlite, 'tenant-b', 'account-b', 'done', jstAgo(HOUR_MS), 'completed');

    seedGrant(sqlite, 'grant-active', 'tenant-a', utcAhead(HOUR_MS));
    seedGrant(sqlite, 'grant-expired', 'tenant-a', utcAgo(HOUR_MS));
    seedGrant(sqlite, 'grant-revoked', 'tenant-b', utcAhead(HOUR_MS), utcAgo(HOUR_MS));

    // tenant-a is live, tenant-c last saw an admin 40 days ago, tenant-b never.
    seedMembership(sqlite, 'tenant-a', 'staff-a1', 1);
    seedMembership(sqlite, 'tenant-c', 'staff-c1', 1);
    seedTenantSession(sqlite, 'tenant-a', 'staff-a1', 'a1', utcAgo(HOUR_MS), utcAhead(DAY_MS));
    seedTenantSession(sqlite, 'tenant-c', 'staff-c1', 'c1', utcAgo(40 * DAY_MS), utcAgo(33 * DAY_MS));
  });

  it('counts tenants, webhook health, grants and stale tenants', async () => {
    const response = await app().request('/api/platform-admin/dashboard', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        totalTenants: 3,
        activeTenants: 2,
        suspendedTenants: 1,
        webhookFailures24h: 2,
        webhookPending: 3,
        activeSupportGrants: 1,
        tenantsWithStaleActivity: 2,
      },
    });
  });

  it('records one list_dashboard access event with no tenant', async () => {
    await app().request('/api/platform-admin/dashboard', { headers: { cookie } }, testEnv);
    expect(accessEvents(sqlite)).toEqual([{
      platform_admin_id: 'staff-platform',
      tenant_id: null,
      action: 'list_dashboard',
      resource_type: null,
      resource_id: null,
      detail_json: null,
    }]);
  });

  it('requires a platform admin session', async () => {
    const response = await app().request('/api/platform-admin/dashboard', {}, testEnv);
    expect(response.status).toBe(401);
    expect(accessEvents(sqlite)).toHaveLength(0);
  });
});

describe('platform admin tenant health', () => {
  let sqlite: Sqlite3Database;
  let cookie: string;
  let testEnv: Env['Bindings'];

  beforeEach(async () => {
    sqlite = fresh('ON');
    cookie = await seedPlatformAdmin(sqlite);
    testEnv = { DB: d1From(sqlite) } as unknown as Env['Bindings'];

    seedTenant(sqlite, 'tenant-a', 'pharmacy-a', 'active');
    seedAccount(sqlite, 'tenant-a', 'account-a', 1);
    seedAccount(sqlite, 'tenant-a', 'account-idle', 0);
    sqlite.prepare(
      `INSERT INTO pharmacy_line_channel_identities (line_account_id, bot_user_id, created_at)
       VALUES ('account-a', 'bot-a', ?)`,
    ).run(utcAgo(0));

    seedReceipt(sqlite, 'tenant-a', 'account-a', 'ok-1', jstAgo(2 * HOUR_MS), 'completed');
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'ok-2', jstAgo(30 * 60 * 1000), 'completed');
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'bad-1', jstAgo(4 * HOUR_MS), 'failed');
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'ok-old', jstAgo(30 * HOUR_MS), 'completed');

    seedMembership(sqlite, 'tenant-a', 'staff-a1', 1);
    seedMembership(sqlite, 'tenant-a', 'staff-a2', 1);
    seedMembership(sqlite, 'tenant-a', 'staff-a3', 0);
    seedTenantSession(sqlite, 'tenant-a', 'staff-a1', 'a1', utcAgo(HOUR_MS), utcAhead(DAY_MS));
    seedTenantSession(sqlite, 'tenant-a', 'staff-a2', 'a2', utcAgo(2 * DAY_MS), utcAgo(DAY_MS));
    seedTenantSession(sqlite, 'tenant-a', 'staff-a3', 'a3', utcAgo(3 * DAY_MS), utcAhead(DAY_MS), utcAgo(DAY_MS));
  });

  it('reports per-account identity and last webhook plus tenant-wide counts', async () => {
    const response = await app().request(
      '/api/platform-admin/tenants/tenant-a/health', { headers: { cookie } }, testEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        tenantId: 'tenant-a',
        lineAccounts: [
          {
            id: 'account-a',
            name: 'Account account-a',
            isActive: true,
            hasChannelIdentity: true,
            lastWebhookAt: jstAgo(30 * 60 * 1000),
          },
          {
            id: 'account-idle',
            name: 'Account account-idle',
            isActive: false,
            hasChannelIdentity: false,
            lastWebhookAt: null,
          },
        ],
        webhook24h: { success: 2, failed: 1 },
        activeStaffCount: 2,
        activeSessionCount: 1,
        lastAdminLoginAt: utcAgo(HOUR_MS),
      },
    });
    expect(accessEvents(sqlite)).toEqual([{
      platform_admin_id: 'staff-platform',
      tenant_id: 'tenant-a',
      action: 'view_tenant_health',
      resource_type: 'tenant',
      resource_id: 'tenant-a',
      detail_json: null,
    }]);
  });

  it('404s an unknown tenant without recording an access event', async () => {
    const response = await app().request(
      '/api/platform-admin/tenants/tenant-zz/health', { headers: { cookie } }, testEnv,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ success: false, error: 'Tenant not found' });
    expect(accessEvents(sqlite)).toHaveLength(0);
  });
});

type IntegrityCheck = {
  name: string;
  status: 'ok' | 'warn' | 'critical';
  affectedCount: number;
  sampleIds: string[];
};

describe('platform admin integrity checks', () => {
  let sqlite: Sqlite3Database;
  let cookie: string;
  let testEnv: Env['Bindings'];

  // Foreign keys off on purpose: the violations these checks exist to surface
  // are exactly the rows that could only have been written while a constraint
  // or trigger was not in force.
  beforeEach(async () => {
    sqlite = fresh('OFF');
    cookie = await seedPlatformAdmin(sqlite);
    testEnv = { DB: d1From(sqlite) } as unknown as Env['Bindings'];
    seedTenant(sqlite, 'tenant-a', 'pharmacy-a', 'active');
    seedAccount(sqlite, 'tenant-a', 'account-a', 1);
  });

  async function run(): Promise<IntegrityCheck[]> {
    const response = await app().request('/api/platform-admin/integrity', { headers: { cookie } }, testEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { success: true; data: IntegrityCheck[] };
    return body.data;
  }

  const byName = (checks: IntegrityCheck[], name: string) =>
    checks.find((check) => check.name === name);

  it('reports ok for every check on a clean database', async () => {
    const checks = await run();
    expect(checks.map((check) => check.name)).toEqual([
      'orphaned_tenant_line_accounts',
      'missing_capability_row',
      'patients_without_active_account_mapping',
      'stale_pending_webhook_events',
      'dangling_source_handoff',
    ]);
    expect(checks.every((check) => check.status === 'ok' && check.affectedCount === 0)).toBe(true);
    expect(checks.every((check) => check.sampleIds.length === 0)).toBe(true);
  });

  it('records exactly one run_integrity_check event for the whole call', async () => {
    await run();
    expect(accessEvents(sqlite)).toEqual([{
      platform_admin_id: 'staff-platform',
      tenant_id: null,
      action: 'run_integrity_check',
      resource_type: null,
      resource_id: null,
      detail_json: JSON.stringify({ failing: [] }),
    }]);
  });

  it('flags a tenant_line_accounts row pointing at a deleted line account as critical', async () => {
    sqlite.prepare(
      `INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
       VALUES ('tenant-a', 'account-ghost', ?, ?)`,
    ).run(utcAgo(0), utcAgo(0));
    expect(byName(await run(), 'orphaned_tenant_line_accounts')).toEqual({
      name: 'orphaned_tenant_line_accounts',
      status: 'critical',
      affectedCount: 1,
      sampleIds: ['account-ghost'],
    });
  });

  it('flags a line account with no capability row as critical', async () => {
    sqlite.exec('DROP TRIGGER line_accounts_default_pharmacy_capability');
    seedAccount(sqlite, 'tenant-a', 'account-nocap', 1);
    expect(byName(await run(), 'missing_capability_row')).toEqual({
      name: 'missing_capability_row',
      status: 'critical',
      affectedCount: 1,
      sampleIds: ['account-nocap'],
    });
  });

  it('warns on patients whose account is not mapped to any tenant, capping samples at five', async () => {
    const now = utcAgo(0);
    sqlite.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, created_at, updated_at)
       VALUES ('account-unmapped', 'channel-unmapped', 'Unmapped', 't', 's', 1, ?, ?)`,
    ).run(now, now);
    for (let index = 0; index < 6; index += 1) {
      sqlite.prepare(
        `INSERT INTO pharmacy_patients
           (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date,
            sex, contact_phone, archived_at, created_at, updated_at)
         VALUES (?, 'account-unmapped', 'friend-1', 'other', '患者', 'カンジャ', '1990-01-01',
                 NULL, NULL, NULL, ?, ?)`,
      ).run(`patient-${index}`, now, now);
    }
    const check = byName(await run(), 'patients_without_active_account_mapping');
    expect(check).toMatchObject({ status: 'warn', affectedCount: 6 });
    expect(check?.sampleIds).toHaveLength(5);
  });

  it('warns on pending webhook rows the sweep should already have picked up', async () => {
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'stuck', jstAgo(2 * HOUR_MS), 'pending');
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'fresh', jstAgo(10 * 60 * 1000), 'pending');
    expect(byName(await run(), 'stale_pending_webhook_events')).toEqual({
      name: 'stale_pending_webhook_events',
      status: 'warn',
      affectedCount: 1,
      sampleIds: ['stuck'],
    });
  });

  it('flags a submission whose source handoff is missing or in another account as critical', async () => {
    // custom_025 blocks these inserts today, so a violation can only exist
    // from before that trigger — drop it to reproduce that historical state.
    sqlite.exec('DROP TRIGGER pharmacy_prescription_submissions_source_handoff_scope_insert');
    const now = utcAgo(0);
    const submission = (id: string, handoffId: string) => sqlite.prepare(
      `INSERT INTO pharmacy_prescription_submissions
         (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
          source_handoff_id, created_at, updated_at)
       VALUES (?, 'account-a', 'friend-1', ?, 'draft', 1, ?, ?, ?)`,
    ).run(id, id, handoffId, now, now);
    sqlite.prepare(
      `INSERT INTO pharmacy_myna_handoffs
         (id, line_account_id, friend_id, patient_id, expectation_id, method, status, source,
          correlation_id, expires_at, created_at, updated_at)
       VALUES ('handoff-other', 'account-other', 'friend-1', NULL, NULL, 'PAPER', 'CREATED',
               'LIFF', 'corr-1', ?, ?, ?)`,
    ).run(utcAhead(DAY_MS), now, now);
    submission('sub-missing', 'handoff-gone');
    submission('sub-cross-account', 'handoff-other');

    const check = byName(await run(), 'dangling_source_handoff');
    expect(check).toMatchObject({ status: 'critical', affectedCount: 2 });
    expect(check?.sampleIds).toEqual(['sub-cross-account', 'sub-missing']);
  });

  it('names every failing check in the access event detail', async () => {
    seedReceipt(sqlite, 'tenant-a', 'account-a', 'stuck', jstAgo(2 * HOUR_MS), 'pending');
    await run();
    expect(accessEvents(sqlite)[0]?.detail_json)
      .toBe(JSON.stringify({ failing: ['stale_pending_webhook_events'] }));
  });
});
