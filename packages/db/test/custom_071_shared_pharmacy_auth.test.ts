import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function db(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES ('tenant-a', '004821', 'Pharmacy A', 'active', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'Pharmacy A', 'synthetic-token', 'synthetic-secret',
            '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
    INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
    VALUES ('tenant-a', 'account-a', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
    INSERT INTO staff_members
      (id, name, role, api_key, is_active, principal_kind, shared_tenant_id, created_at, updated_at)
    VALUES ('shared-a', 'Pharmacy A shared', 'admin', 'disabled:shared-a', 1,
            'pharmacy_shared', 'tenant-a', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
    INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES ('tenant-a', 'shared-a', 'admin', 1, '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
  `);
  return sqlite;
}

describe('custom_071 shared pharmacy auth', () => {
  it('keeps old credentials disabled and records only the new auth fields', () => {
    const sqlite = db();
    const credential = sqlite.prepare(
      `PRAGMA table_info(tenant_admin_credentials)`,
    ).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    expect(credential.find((column) => column.name === 'auth_enabled')).toMatchObject({
      notnull: 1,
      dflt_value: '0',
    });
    expect(sqlite.prepare(
      `SELECT principal_kind, shared_tenant_id FROM staff_members WHERE id = 'shared-a'`,
    ).get()).toEqual({ principal_kind: 'pharmacy_shared', shared_tenant_id: 'tenant-a' });
    expect(sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pharmacy_auth_audit_events'`,
    ).get()).toEqual({ name: 'pharmacy_auth_audit_events' });
    const auditColumns = sqlite.prepare(`PRAGMA table_info(pharmacy_auth_audit_events)`).all()
      .map((column) => (column as { name: string }).name);
    const forbidden = new Set(['password', 'password_hash', 'token', 'body', 'payload_json', 'phi']);
    expect(auditColumns.filter((name) => forbidden.has(name))).toEqual([]);
  });

  it('allows exactly one shared principal per tenant and blocks identity bypasses', () => {
    const sqlite = db();
    expect(() => sqlite.prepare(
      `INSERT INTO staff_members
        (id, name, role, api_key, is_active, principal_kind, shared_tenant_id, created_at, updated_at)
       VALUES ('shared-b', 'Second shared', 'admin', 'disabled:shared-b', 1,
               'pharmacy_shared', 'tenant-a', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`,
    ).run()).toThrow(/UNIQUE/);
    expect(() => sqlite.prepare(
      `UPDATE staff_members SET principal_kind = 'human'
        WHERE id = 'shared-a'`,
    ).run()).toThrow(/PHARMACY_SHARED_STAFF_IDENTITY_IMMUTABLE/);
    expect(() => sqlite.prepare(
      `INSERT INTO pharmacy_staff_accounts
        (line_account_id, staff_id, is_active, created_at, updated_at)
       VALUES ('account-a', 'shared-a', 1, '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`,
    ).run()).toThrow(/PHARMACY_SHARED_ACCOUNT_ASSIGNMENT_FORBIDDEN/);
  });

  it('requires the pharmacy code for a shared credential and revokes all sessions on rotation', () => {
    const sqlite = db();
    sqlite.prepare(
      `INSERT INTO tenant_admin_credentials
        (tenant_id, staff_id, login_id, password_hash, must_change_password,
         credential_version, auth_enabled, created_at, updated_at)
       VALUES ('tenant-a', 'shared-a', '004821', 'synthetic-hash', 1, 1, 1,
               '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind,
         expires_at, revoked_at, created_at)
       VALUES (?, 'tenant-a', 'shared-a', 1, 'standard', '2099-01-01T00:00:00Z', NULL, ?)`,
    ).run('a'.repeat(64), '2026-09-14T00:00:00Z');
    expect(() => sqlite.prepare(
      `UPDATE tenant_admin_credentials SET login_id = 'individual-owner'
        WHERE tenant_id = 'tenant-a' AND staff_id = 'shared-a'`,
    ).run()).toThrow(/PHARMACY_SHARED_CREDENTIAL_INVALID/);
    sqlite.prepare(
      `UPDATE tenant_admin_credentials
          SET password_hash = 'synthetic-next-hash',
              credential_version = 2
        WHERE tenant_id = 'tenant-a' AND staff_id = 'shared-a'`,
    ).run();
    expect(sqlite.prepare(
      `SELECT revoked_at IS NOT NULL AS revoked FROM tenant_admin_sessions WHERE token_hash = ?`,
    ).get('a'.repeat(64))).toEqual({ revoked: 1 });
    expect(() => sqlite.prepare(
      `UPDATE tenant_admin_sessions SET revoked_at = NULL WHERE token_hash = ?`,
    ).run('a'.repeat(64))).toThrow(/PHARMACY_SESSION_REVIVAL_FORBIDDEN/);
  });

  it('keeps authentication audit rows append-only', () => {
    const sqlite = db();
    sqlite.prepare(
      `INSERT INTO pharmacy_auth_audit_events
        (id, actor_kind, actor_staff_id, target_tenant_id, target_staff_id,
         action, outcome, reason_code, request_id, created_at)
       VALUES ('audit-1', 'unauthenticated', NULL, 'tenant-a', 'shared-a',
               'login', 'failure', 'bad_password', 'request-1', '2026-09-14T00:00:00Z')`,
    ).run();
    expect(() => sqlite.prepare(
      `UPDATE pharmacy_auth_audit_events SET reason_code = 'changed' WHERE id = 'audit-1'`,
    ).run()).toThrow(/PHARMACY_AUTH_AUDIT_IMMUTABLE/);
    expect(() => sqlite.prepare(
      `DELETE FROM pharmacy_auth_audit_events WHERE id = 'audit-1'`,
    ).run()).toThrow(/PHARMACY_AUTH_AUDIT_DELETE_FORBIDDEN/);
    expect(() => sqlite.prepare(
      `INSERT OR REPLACE INTO pharmacy_auth_audit_events
        (id, actor_kind, actor_staff_id, target_tenant_id, target_staff_id,
         action, outcome, reason_code, request_id, created_at)
       VALUES ('audit-1', 'unauthenticated', NULL, 'tenant-a', 'shared-a',
               'login', 'failure', 'replaced', 'request-2', '2026-09-14T00:00:01Z')`,
    ).run()).toThrow(/PHARMACY_AUTH_AUDIT_ID_REUSE_FORBIDDEN/);
    expect(sqlite.prepare(
      `SELECT reason_code FROM pharmacy_auth_audit_events WHERE id = 'audit-1'`,
    ).get()).toEqual({ reason_code: 'bad_password' });
    expect(() => sqlite.prepare(
      `INSERT INTO pharmacy_auth_audit_events
        (id, actor_kind, action, outcome, reason_code, request_id, created_at)
       VALUES (NULL, 'system', 'login', 'failure', 'test', 'request-null', '2026-09-14T00:00:02Z')`,
    ).run()).toThrow(/NOT NULL/);
  });

  it('blocks shared identity replacement, reassignment, and session token reuse', () => {
    const sqlite = db();
    const tokenHash = 'a'.repeat(64);
    sqlite.exec(`
      INSERT INTO staff_members
        (id, name, role, api_key, is_active, principal_kind, created_at, updated_at)
      VALUES ('human-a', 'Human A', 'admin', 'disabled:human-a', 1, 'human',
              '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO tenant_staff_memberships
        (tenant_id, staff_id, role, is_active, created_at, updated_at)
      VALUES ('tenant-a', 'human-a', 'admin', 1, '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO tenant_admin_credentials
        (tenant_id, staff_id, login_id, password_hash, must_change_password,
         credential_version, auth_enabled, created_at, updated_at)
      VALUES ('tenant-a', 'shared-a', '004821', 'synthetic-hash', 0, 1, 1,
              '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind,
         expires_at, revoked_at, created_at)
      VALUES ('${tokenHash}', 'tenant-a', 'shared-a', 1, 'standard', '2099-01-01T00:00:00Z', NULL,
              '2026-09-14T00:00:00Z');
      INSERT INTO pharmacy_staff_accounts
        (line_account_id, staff_id, is_active, created_at, updated_at)
      VALUES ('account-a', 'human-a', 1, '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO staff_members
        (id, name, role, api_key, is_active, principal_kind, created_at, updated_at)
      VALUES ('human-b', 'Human B', 'admin', 'disabled:human-b', 1, 'human',
              '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO tenant_staff_memberships
        (tenant_id, staff_id, role, is_active, created_at, updated_at)
      VALUES ('tenant-a', 'human-b', 'admin', 1, '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO pharmacy_staff_accounts
        (line_account_id, staff_id, is_active, created_at, updated_at)
      VALUES ('account-a', 'human-b', 1, '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
    `);

    expect(() => sqlite.prepare(
      `INSERT OR REPLACE INTO staff_members
        (id, name, role, api_key, is_active, principal_kind, shared_tenant_id, created_at, updated_at)
       VALUES ('shared-a', 'Replaced', 'admin', 'disabled:replaced', 1, 'human', NULL,
               '2026-09-14T00:00:01Z', '2026-09-14T00:00:01Z')`,
    ).run()).toThrow(/PHARMACY_SHARED_STAFF_ID_REUSE_FORBIDDEN/);
    expect(() => sqlite.prepare(
      `UPDATE tenant_admin_credentials SET staff_id = 'human-a', auth_enabled = 0
        WHERE tenant_id = 'tenant-a' AND staff_id = 'shared-a'`,
    ).run()).toThrow(/PHARMACY_SHARED_CREDENTIAL_IDENTITY_IMMUTABLE/);
    sqlite.prepare(
      `UPDATE pharmacy_staff_accounts SET is_active = 0
        WHERE line_account_id = 'account-a' AND staff_id = 'human-a'`,
    ).run();
    expect(() => sqlite.prepare(
      `UPDATE pharmacy_staff_accounts SET staff_id = 'shared-a'
        WHERE line_account_id = 'account-a' AND staff_id = 'human-a'`,
    ).run()).toThrow(/PHARMACY_SHARED_ACCOUNT_ASSIGNMENT_FORBIDDEN/);
    expect(() => sqlite.prepare(
      `UPDATE tenant_admin_sessions SET token_hash = ? WHERE token_hash = ?`,
    ).bind('b'.repeat(64), tokenHash).run()).toThrow(/PHARMACY_SESSION_IDENTITY_IMMUTABLE/);
    expect(() => sqlite.prepare(
      `DELETE FROM tenant_admin_sessions WHERE token_hash = ?`,
    ).bind(tokenHash).run()).toThrow(/PHARMACY_SESSION_DELETE_FORBIDDEN/);
  });

  it('allows safe shared-account disable after membership stop and revokes sessions', () => {
    const sqlite = db();
    const tokenHash = 'c'.repeat(64);
    sqlite.exec(`
      INSERT INTO tenant_admin_credentials
        (tenant_id, staff_id, login_id, password_hash, must_change_password,
         credential_version, auth_enabled, created_at, updated_at)
      VALUES ('tenant-a', 'shared-a', '004821', 'synthetic-hash', 0, 1, 1,
              '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');
      INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind,
         expires_at, revoked_at, created_at)
      VALUES ('${tokenHash}', 'tenant-a', 'shared-a', 1, 'standard', '2099-01-01T00:00:00Z', NULL,
              '2026-09-14T00:00:00Z');
      UPDATE tenant_staff_memberships SET is_active = 0
       WHERE tenant_id = 'tenant-a' AND staff_id = 'shared-a';
      UPDATE tenant_admin_credentials SET auth_enabled = 0
       WHERE tenant_id = 'tenant-a' AND staff_id = 'shared-a';
    `);
    expect(sqlite.prepare(
      `SELECT auth_enabled FROM tenant_admin_credentials WHERE tenant_id = 'tenant-a' AND staff_id = 'shared-a'`,
    ).get()).toEqual({ auth_enabled: 0 });
    expect(sqlite.prepare(
      `SELECT revoked_at IS NOT NULL AS revoked FROM tenant_admin_sessions WHERE token_hash = '${tokenHash}'`,
    ).get()).toEqual({ revoked: 1 });
  });
});
