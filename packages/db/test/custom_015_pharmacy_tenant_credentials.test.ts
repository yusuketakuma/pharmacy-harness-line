import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.exec(`
    INSERT INTO tenants (id, tenant_code, display_name) VALUES
      ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES
      ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
      ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
    INSERT INTO staff_members (id, name, role, api_key) VALUES
      ('staff-a', 'A', 'owner', 'key-a'), ('staff-b', 'B', 'owner', 'key-b');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES
      ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
    INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role) VALUES
      ('tenant-a', 'staff-a', 'owner'), ('tenant-b', 'staff-b', 'owner');
  `);
  return db;
}

describe('custom_015_pharmacy_tenant_credentials.sql', () => {
  it('scopes login IDs and credentials to one tenant', () => {
    const db = database();

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
    db.prepare(`INSERT INTO tenant_admin_credentials
      (tenant_id, staff_id, login_id, password_hash, credential_version, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'admin-a', 'hash', 1, '2026-08-18', '2026-08-18')`).run();
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
      .toThrow(/inactive tenant admin authority/i);

    db.prepare(`INSERT INTO pharmacy_line_channel_identities
      (line_account_id, bot_user_id, created_at) VALUES ('account-a', 'U-bot-a', '2026-08-18')`).run();
    expect(() => db.prepare(`INSERT INTO pharmacy_line_channel_identities
      (line_account_id, bot_user_id, created_at) VALUES ('account-b', 'U-bot-a', '2026-08-18')`).run())
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('makes LINE Login and LIFF selectors globally unambiguous', () => {
    const db = database();
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

});
