import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { adminAuth } from '../../../routes/admin/admin-auth.js';
import {
  PLATFORM_ADMIN_CSRF_HEADER,
  platformAdminAuthMiddleware,
} from '../platform-admin/auth.js';
import { createAccessGrant } from '../platform-admin/access-grant.js';
import { platformAdminRoutes } from '../platform-admin/routes.js';
import {
  generatePlatformAdminSessionToken,
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
} from './credentials.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type SqliteDatabase = {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => SqliteDatabase;
const BOOTSTRAP = readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8');

function d1From(sqlite: SqliteDatabase, beforeFirstBatch: () => void): D1Database {
  let batchCount = 0;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: result.changes }, results: [] };
    },
    __run: () => {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: result.changes }, results: [] };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ __run(): D1Result }>) => {
      batchCount += 1;
      if (batchCount === 1) beforeFirstBatch();
      return sqlite.transaction(() => statements.map((item) => item.__run()))();
    },
  } as unknown as D1Database;
}

function bindings(db: D1Database): Env['Bindings'] {
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
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-token-key-for-tests',
  };
}

function tenantApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', adminAuth);
  return app;
}

function platformApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('/api/platform-admin/*', platformAdminAuthMiddleware);
  app.route('/', platformAdminRoutes);
  return app;
}

function preauthenticatedPlatformApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use('/api/platform-admin/*', async (c, next) => {
    c.set('platformAdmin', { id: 'platform-a', name: 'Platform A' });
    await next();
  });
  app.route('/', platformAdminRoutes);
  return app;
}

function fresh(): SqliteDatabase {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(BOOTSTRAP);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return sqlite;
}

const CURRENT_PASSWORD = 'Current password 42';
const LOSER_PASSWORD = 'Loser password 43';
const WINNER_PASSWORD = 'Winner password 44';
const FUTURE = '2099-01-01T00:00:00.000Z';

describe('password change OCC loser', () => {
  it('does not append a tenant password-change audit after losing the credential CAS', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const winnerHash = await hashTenantPassword(WINNER_PASSWORD);
      const token = generateTenantAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      const winnerSessionHash = 'a'.repeat(64);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-a', 'Staff A', 'owner', 'key-a', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-a', 'owner', 1);
      `);
      sqlite.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('tenant-a', 'staff-a', 'admin-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO tenant_admin_sessions
           (token_hash, tenant_id, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'tenant-a', 'staff-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE tenant_admin_credentials
              SET password_hash = ?, credential_version = 2, updated_at = ?
            WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`,
        ).run(winnerHash, '2026-08-30T00:01:00.000Z');
        sqlite.prepare(
          `UPDATE tenant_admin_sessions SET revoked_at = ?
            WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a' AND credential_version = 1`,
        ).run('2026-08-30T00:01:00.000Z');
        sqlite.prepare(
          `INSERT INTO tenant_admin_sessions
             (token_hash, tenant_id, staff_id, credential_version, session_kind,
              expires_at, revoked_at, created_at)
           VALUES (?, 'tenant-a', 'staff-a', 2, 'standard', ?, NULL, ?)`,
        ).run(winnerSessionHash, FUTURE, '2026-08-30T00:01:00.000Z');
      });

      const csrf = 'tenant-csrf';
      const response = await tenantApp().request('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_admin_session=${token}; lh_tenant=tenant-a; lh_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_audit_events
          WHERE action = 'staff.password_changed'`,
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
      ).get(winnerSessionHash)).toEqual({ revoked_at: null });
    } finally {
      sqlite.close();
    }
  });

  it('does not revoke a winner session grant or append audit after a platform CAS loss', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const winnerHash = await hashTenantPassword(WINNER_PASSWORD);
      const token = generatePlatformAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      const winnerSessionHash = 'b'.repeat(64);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('platform-a', 'Platform A', 'owner', 'key-platform-a', 1);
        INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
        VALUES ('platform-a', 1, '${now}', '${now}');
      `);
      sqlite.prepare(
        `INSERT INTO platform_admin_credentials
           (staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('platform-a', 'platform-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO platform_admin_sessions
           (token_hash, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'platform-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE platform_admin_credentials
              SET password_hash = ?, credential_version = 2, updated_at = ?
            WHERE staff_id = 'platform-a'`,
        ).run(winnerHash, '2026-08-30T00:01:00.000Z');
        sqlite.prepare(
          `UPDATE platform_admin_sessions SET revoked_at = ?
            WHERE staff_id = 'platform-a' AND credential_version = 1`,
        ).run('2026-08-30T00:01:00.000Z');
        sqlite.prepare(
          `INSERT INTO platform_admin_sessions
             (token_hash, staff_id, credential_version, session_kind,
              expires_at, revoked_at, created_at)
           VALUES (?, 'platform-a', 2, 'standard', ?, NULL, ?)`,
        ).run(winnerSessionHash, FUTURE, '2026-08-30T00:01:00.000Z');
        sqlite.prepare(
          `INSERT INTO platform_admin_access_grants
             (id, platform_admin_id, tenant_id, scopes, reason,
              reauth_verified_at, issued_at, expires_at, session_token_hash)
           VALUES ('winner-grant', 'platform-a', 'tenant-a', '["phi:read"]', 'support',
                   ?, ?, ?, ?)`,
        ).run(
          '2026-08-30T00:01:00.000Z',
          '2026-08-30T00:01:00.000Z',
          FUTURE,
          winnerSessionHash,
        );
      });

      const csrf = 'platform-csrf';
      const response = await platformApp().request('/api/platform-admin/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_platform_admin_session=${token}; lh_platform_admin_csrf=${csrf}`,
          [PLATFORM_ADMIN_CSRF_HEADER]: csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT revoked_at FROM platform_admin_access_grants WHERE id = 'winner-grant'`,
      ).get()).toEqual({ revoked_at: null });
      expect(sqlite.prepare(
        `SELECT revoked_at FROM platform_admin_sessions WHERE token_hash = ?`,
      ).get(winnerSessionHash)).toEqual({ revoked_at: null });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_access_events
          WHERE action = 'change_password'`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when tenant authority is disabled after auth and before the CAS', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generateTenantAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-a', 'Staff A', 'admin', 'key-a', 1);
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-owner', 'Staff Owner', 'owner', 'key-owner', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-a', 'admin', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-owner', 'owner', 1);
      `);
      sqlite.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('tenant-a', 'staff-a', 'admin-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO tenant_admin_sessions
           (token_hash, tenant_id, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'tenant-a', 'staff-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE tenant_staff_memberships SET is_active = 0
            WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`,
        ).run();
      });
      const csrf = 'tenant-csrf';
      const response = await tenantApp().request('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_admin_session=${token}; lh_tenant=tenant-a; lh_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT password_hash, must_change_password, credential_version, updated_at
           FROM tenant_admin_credentials
          WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`,
      ).get()).toEqual({
        password_hash: currentHash,
        must_change_password: 0,
        credential_version: 1,
        updated_at: now,
      });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_audit_events
          WHERE action = 'staff.password_changed'`,
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_sessions
          WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`,
      ).get()).toEqual({ count: 1 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_sessions
          WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a' AND credential_version = 2`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when platform authority is disabled after auth and before the CAS', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generatePlatformAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      sqlite.exec(`
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('platform-a', 'Platform A', 'owner', 'key-platform-a', 1);
        INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
        VALUES ('platform-a', 1, '${now}', '${now}');
      `);
      sqlite.prepare(
        `INSERT INTO platform_admin_credentials
           (staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('platform-a', 'platform-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO platform_admin_sessions
           (token_hash, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'platform-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE platform_admins SET is_active = 0 WHERE staff_id = 'platform-a'`,
        ).run();
      });
      const csrf = 'platform-csrf';
      const response = await platformApp().request('/api/platform-admin/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_platform_admin_session=${token}; lh_platform_admin_csrf=${csrf}`,
          [PLATFORM_ADMIN_CSRF_HEADER]: csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT password_hash, must_change_password, credential_version, updated_at
           FROM platform_admin_credentials WHERE staff_id = 'platform-a'`,
      ).get()).toEqual({
        password_hash: currentHash,
        must_change_password: 0,
        credential_version: 1,
        updated_at: now,
      });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_access_events
          WHERE action = 'change_password'`,
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_sessions
          WHERE staff_id = 'platform-a'`,
      ).get()).toEqual({ count: 1 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_sessions
          WHERE staff_id = 'platform-a' AND credential_version = 2`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when the tenant caller session is revoked after auth and before the CAS', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const revokedAt = '2026-08-30T00:01:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generateTenantAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-a', 'Staff A', 'admin', 'key-a', 1);
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-owner', 'Staff Owner', 'owner', 'key-owner', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-a', 'admin', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-owner', 'owner', 1);
      `);
      sqlite.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('tenant-a', 'staff-a', 'admin-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO tenant_admin_sessions
           (token_hash, tenant_id, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'tenant-a', 'staff-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE tenant_admin_sessions SET revoked_at = ? WHERE token_hash = ?`,
        ).run(revokedAt, tokenHash);
      });
      const csrf = 'tenant-csrf';
      const response = await tenantApp().request('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_admin_session=${token}; lh_tenant=tenant-a; lh_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT password_hash, must_change_password, credential_version, updated_at
           FROM tenant_admin_credentials
          WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`,
      ).get()).toEqual({
        password_hash: currentHash,
        must_change_password: 0,
        credential_version: 1,
        updated_at: now,
      });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_audit_events
          WHERE action = 'staff.password_changed'`,
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
      ).get(tokenHash)).toEqual({ revoked_at: revokedAt });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_sessions
          WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a' AND credential_version = 2`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when the platform caller session is revoked after auth and before the CAS', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const revokedAt = '2026-08-30T00:01:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generatePlatformAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      sqlite.exec(`
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('platform-a', 'Platform A', 'owner', 'key-platform-a', 1);
        INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
        VALUES ('platform-a', 1, '${now}', '${now}');
      `);
      sqlite.prepare(
        `INSERT INTO platform_admin_credentials
           (staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('platform-a', 'platform-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO platform_admin_sessions
           (token_hash, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'platform-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE platform_admin_sessions SET revoked_at = ? WHERE token_hash = ?`,
        ).run(revokedAt, tokenHash);
      });
      const csrf = 'platform-csrf';
      const response = await platformApp().request('/api/platform-admin/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_platform_admin_session=${token}; lh_platform_admin_csrf=${csrf}`,
          [PLATFORM_ADMIN_CSRF_HEADER]: csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT password_hash, must_change_password, credential_version, updated_at
           FROM platform_admin_credentials WHERE staff_id = 'platform-a'`,
      ).get()).toEqual({
        password_hash: currentHash,
        must_change_password: 0,
        credential_version: 1,
        updated_at: now,
      });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_access_events
          WHERE action = 'change_password'`,
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        `SELECT revoked_at FROM platform_admin_sessions WHERE token_hash = ?`,
      ).get(tokenHash)).toEqual({ revoked_at: revokedAt });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_sessions
          WHERE staff_id = 'platform-a' AND credential_version = 2`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });
});

describe('support grant OCC loser', () => {
  it('does not persist a grant or success audit after its session is revoked', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const passwordHash = await hashTenantPassword(CURRENT_PASSWORD);
      const tokenHash = 'b'.repeat(64);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('platform-a', 'Platform A', 'owner', 'key-platform-a', 1);
        INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
        VALUES ('platform-a', 1, '${now}', '${now}');
      `);
      sqlite.prepare(
        `INSERT INTO platform_admin_credentials
           (staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('platform-a', 'platform-a', ?, 0, 1, ?, ?)`,
      ).run(passwordHash, now, now);
      sqlite.prepare(
        `INSERT INTO platform_admin_sessions
           (token_hash, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'platform-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE platform_admin_sessions SET revoked_at = ? WHERE token_hash = ?`,
        ).run('2026-08-30T00:01:00.000Z', tokenHash);
      });

      await expect(createAccessGrant(db, 'platform-a', 'tenant-a', {
        reason: 'Investigating a delivery complaint',
        ticketReference: 'OPS-1',
        scopes: ['phi:read'],
        currentPassword: CURRENT_PASSWORD,
        sessionTokenHash: tokenHash,
      })).rejects.toMatchObject({ status: 403 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_access_grants`,
      ).get()).toEqual({ count: 0 });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM platform_admin_access_events
          WHERE action = 'support_mode_started'`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });
});

describe('tenant session control OCC loser', () => {
  it('does not revoke other sessions after the caller session is revoked', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generateTenantAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      const otherTokenHash = 'c'.repeat(64);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-a', 'Staff A', 'owner', 'key-a', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-a', 'owner', 1);
      `);
      sqlite.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('tenant-a', 'staff-a', 'admin-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO tenant_admin_sessions
           (token_hash, tenant_id, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES
           (?, 'tenant-a', 'staff-a', 1, 'standard', ?, NULL, ?),
           (?, 'tenant-a', 'staff-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now, otherTokenHash, FUTURE, now);

      const revokedAt = '2026-08-30T00:01:00.000Z';
      const db = d1From(sqlite, () => {
        sqlite.prepare(
          `UPDATE tenant_admin_sessions SET revoked_at = ? WHERE token_hash = ?`,
        ).run(revokedAt, tokenHash);
      });
      const csrf = 'tenant-csrf';
      const response = await tenantApp().request('/api/auth/sessions/revoke-others', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_admin_session=${token}; lh_tenant=tenant-a; lh_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD }),
      }, bindings(db));

      expect(response.status).toBe(409);
      expect(sqlite.prepare(
        `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
      ).get(tokenHash)).toEqual({ revoked_at: revokedAt });
      expect(sqlite.prepare(
        `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
      ).get(otherTokenHash)).toEqual({ revoked_at: null });
      expect(sqlite.prepare(
        `SELECT COUNT(*) AS count FROM tenant_admin_audit_events
          WHERE action = 'staff.other_sessions_revoked'`,
      ).get()).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('revokes the replacement session when a stale tenant logout finishes last', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generateTenantAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('staff-a', 'Staff A', 'owner', 'key-a', 1);
        INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
        VALUES ('tenant-a', 'staff-a', 'owner', 1);
      `);
      sqlite.prepare(
        `INSERT INTO tenant_admin_credentials
           (tenant_id, staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('tenant-a', 'staff-a', 'admin-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO tenant_admin_sessions
           (token_hash, tenant_id, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'tenant-a', 'staff-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {});
      const csrf = 'tenant-csrf';
      const changed = await tenantApp().request('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_admin_session=${token}; lh_tenant=tenant-a; lh_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));
      expect(changed.status).toBe(200);

      const logout = await tenantApp().request('/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `lh_admin_session=${token}; lh_tenant=tenant-a` },
      }, bindings(db));
      expect(logout.status).toBe(200);
      expect(sqlite.prepare(
        `SELECT session_family_hash, revoked_at
           FROM tenant_admin_sessions
          WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'
            AND credential_version = 2`,
      ).get()).toMatchObject({
        session_family_hash: tokenHash,
        revoked_at: expect.any(String),
      });
    } finally {
      sqlite.close();
    }
  });

  it('revokes the replacement session grant when a stale platform logout finishes last', async () => {
    const sqlite = fresh();
    try {
      const now = '2026-08-30T00:00:00.000Z';
      const currentHash = await hashTenantPassword(CURRENT_PASSWORD);
      const token = generatePlatformAdminSessionToken();
      const tokenHash = await hashTenantAdminSessionToken(token);
      sqlite.exec(`
        INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active');
        INSERT INTO staff_members (id, name, role, api_key, is_active)
        VALUES ('platform-a', 'Platform A', 'owner', 'key-platform-a', 1);
        INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
        VALUES ('platform-a', 1, '${now}', '${now}');
      `);
      sqlite.prepare(
        `INSERT INTO platform_admin_credentials
           (staff_id, login_id, password_hash, must_change_password,
            credential_version, created_at, updated_at)
         VALUES ('platform-a', 'platform-a', ?, 0, 1, ?, ?)`,
      ).run(currentHash, now, now);
      sqlite.prepare(
        `INSERT INTO platform_admin_sessions
           (token_hash, staff_id, credential_version, session_kind,
            expires_at, revoked_at, created_at)
         VALUES (?, 'platform-a', 1, 'standard', ?, NULL, ?)`,
      ).run(tokenHash, FUTURE, now);

      const db = d1From(sqlite, () => {});
      const csrf = 'platform-csrf';
      const changed = await platformApp().request('/api/platform-admin/change-password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `lh_platform_admin_session=${token}; lh_platform_admin_csrf=${csrf}`,
          [PLATFORM_ADMIN_CSRF_HEADER]: csrf,
        },
        body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: LOSER_PASSWORD }),
      }, bindings(db));
      expect(changed.status).toBe(200);

      const replacement = sqlite.prepare(
        `SELECT token_hash, session_family_hash
           FROM platform_admin_sessions
          WHERE staff_id = 'platform-a' AND credential_version = 2`,
      ).get() as { token_hash: string; session_family_hash: string | null };
      sqlite.prepare(
        `INSERT INTO platform_admin_access_grants
           (id, platform_admin_id, tenant_id, scopes, reason,
            reauth_verified_at, issued_at, expires_at, session_token_hash)
         VALUES ('replacement-grant', 'platform-a', 'tenant-a', '["phi:read"]', 'support',
                 ?, ?, ?, ?)`,
      ).run(now, now, FUTURE, replacement.token_hash);

      const logout = await preauthenticatedPlatformApp().request('/api/platform-admin/logout', {
        method: 'POST',
        headers: { cookie: `lh_platform_admin_session=${token}` },
      }, bindings(db));
      expect(logout.status).toBe(200);
      expect(sqlite.prepare(
        `SELECT session_family_hash, revoked_at
           FROM platform_admin_sessions WHERE token_hash = ?`,
      ).get(replacement.token_hash)).toMatchObject({
        session_family_hash: tokenHash,
        revoked_at: expect.any(String),
      });
      expect(sqlite.prepare(
        `SELECT revoked_at FROM platform_admin_access_grants WHERE id = 'replacement-grant'`,
      ).get()).toMatchObject({ revoked_at: expect.any(String) });
    } finally {
      sqlite.close();
    }
  });
});
