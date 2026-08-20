import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', 'custom_015_pharmacy_tenant_credentials.sql');

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      login_channel_id TEXT,
      liff_id TEXT
    );
    CREATE TABLE staff_members (id TEXT PRIMARY KEY);
    CREATE TABLE tenant_line_accounts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (tenant_id, line_account_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
    );
    CREATE TABLE tenant_staff_memberships (
      tenant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, staff_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (staff_id) REFERENCES staff_members(id)
    );
    INSERT INTO tenants VALUES ('tenant-a'), ('tenant-b');
    INSERT INTO line_accounts (id) VALUES ('account-a'), ('account-b');
    INSERT INTO staff_members VALUES ('staff-a'), ('staff-b');
    INSERT INTO tenant_line_accounts VALUES ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
    INSERT INTO tenant_staff_memberships VALUES ('tenant-a', 'staff-a'), ('tenant-b', 'staff-b');
  `);
  return db;
}

describe('custom_015_pharmacy_tenant_credentials.sql', () => {
  it('scopes login IDs and credentials to one tenant', () => {
    const db = database();
    db.exec(readFileSync(MIGRATION, 'utf8'));

    const insert = db.prepare(`INSERT INTO tenant_admin_credentials
      (tenant_id, staff_id, login_id, password_hash, must_change_password,
       credential_version, created_at, updated_at)
      VALUES (?, ?, ?, 'pbkdf2-sha256$210000$salt$hash', 1, 1, '2026-08-18', '2026-08-18')`);
    expect(() => insert.run('tenant-a', 'staff-a', 'admin')).not.toThrow();
    expect(() => insert.run('tenant-b', 'staff-b', 'ADMIN')).not.toThrow();
    expect(() => insert.run('tenant-a', 'staff-b', 'ADMIN')).toThrow();
  });

  it('keeps provisioning receipts bound to the created tenant resources', () => {
    const db = database();
    db.exec(readFileSync(MIGRATION, 'utf8'));

    expect(() => db.prepare(`INSERT INTO pharmacy_tenant_provisioning_requests
      (idempotency_key_hash, request_hash, actor_key_hash, tenant_id, line_account_id, staff_id, created_at)
      VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'hash-a', 'actor-a',
              'tenant-a', 'account-a', 'staff-a', '2026-08-18')`).run())
      .not.toThrow();
    expect(() => db.prepare(`INSERT INTO pharmacy_tenant_provisioning_requests
      (idempotency_key_hash, request_hash, actor_key_hash, tenant_id, line_account_id, staff_id, created_at)
      VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'hash-b', 'actor-b',
              'tenant-a', 'account-b', 'staff-a', '2026-08-18')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('keeps revocable sessions tenant-bound and canonical LINE bots unique', () => {
    const db = database();
    db.exec(readFileSync(MIGRATION, 'utf8'));
    db.prepare(`INSERT INTO tenant_admin_sessions
      (token_hash, tenant_id, staff_id, credential_version, session_kind,
       expires_at, revoked_at, created_at)
      VALUES (?, 'tenant-a', 'staff-a', 1, 'bootstrap', '2026-08-19', NULL, '2026-08-18')`)
      .run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(() => db.prepare(`INSERT INTO tenant_admin_sessions
      (token_hash, tenant_id, staff_id, credential_version, session_kind,
       expires_at, revoked_at, created_at)
      VALUES (?, 'tenant-a', 'staff-b', 1, 'standard', '2026-08-19', NULL, '2026-08-18')`)
      .run('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
      .toThrow(/FOREIGN KEY constraint failed/i);

    db.prepare(`INSERT INTO pharmacy_line_channel_identities
      (line_account_id, bot_user_id, created_at) VALUES ('account-a', 'U-bot-a', '2026-08-18')`).run();
    expect(() => db.prepare(`INSERT INTO pharmacy_line_channel_identities
      (line_account_id, bot_user_id, created_at) VALUES ('account-b', 'U-bot-a', '2026-08-18')`).run())
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('makes LINE Login and LIFF selectors globally unambiguous', () => {
    const db = database();
    db.exec(readFileSync(MIGRATION, 'utf8'));
    db.prepare(`UPDATE line_accounts
                   SET login_channel_id = 'login-a', liff_id = 'liff-a'
                 WHERE id = 'account-a'`).run();
    expect(() => db.prepare(`UPDATE line_accounts
                                SET login_channel_id = 'login-a'
                              WHERE id = 'account-b'`).run())
      .toThrow(/UNIQUE constraint failed/i);
    expect(() => db.prepare(`UPDATE line_accounts
                                SET liff_id = 'liff-a'
                              WHERE id = 'account-b'`).run())
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('is idempotent for migration retry', () => {
    const db = database();
    const migration = readFileSync(MIGRATION, 'utf8');
    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
  });
});
