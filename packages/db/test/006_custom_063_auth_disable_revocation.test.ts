import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TENANT_SESSION_A = 'a'.repeat(64);
const PLATFORM_SESSION_A = 'b'.repeat(64);
const TENANT_SESSION_B = 'c'.repeat(64);
const TENANT_SESSION_C = 'd'.repeat(64);
const PLATFORM_SESSION_B = 'e'.repeat(64);
const PLATFORM_SESSION_REVOKED = '4'.repeat(64);
const PLATFORM_SESSION_EXPIRED = '5'.repeat(64);
const PLATFORM_SESSION_STALE = '6'.repeat(64);
const PLATFORM_SESSION_DISABLED = '7'.repeat(64);

function insertGrant(db: Database.Database, id: string, sessionTokenHash: string): void {
  db.prepare(
    `INSERT INTO platform_admin_access_grants
       (id, platform_admin_id, tenant_id, scopes, reason, reauth_verified_at,
        issued_at, expires_at, session_token_hash)
     VALUES (?, 'staff-a', 'tenant-a', '["phi:read"]', 'support', ?, ?, ?, ?)`,
  ).run(
    id,
    '2026-08-30T00:00:00.000Z',
    '2026-08-30T00:00:00.000Z',
    '2099-01-01T00:00:00.000Z',
    sessionTokenHash,
  );
}

describe('006 custom_063 auth disable revocation', () => {
  it('revokes live sessions when their tenant, membership, or staff authority is disabled', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name)
      VALUES ('tenant-a', 'a', 'A');
      INSERT INTO staff_members (id, name, role, api_key)
      VALUES ('staff-a', 'Staff A', 'admin', 'key-a');
      INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role)
      VALUES ('tenant-a', 'staff-a', 'admin');
      INSERT INTO tenant_admin_credentials
        (tenant_id, staff_id, login_id, password_hash, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'admin-a', 'hash', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
      VALUES ('staff-a', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO platform_admin_credentials
        (staff_id, login_id, password_hash, created_at, updated_at)
      VALUES ('staff-a', 'platform-a', 'hash', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES ('${TENANT_SESSION_A}', 'tenant-a', 'staff-a', 1, 'standard',
              '2099-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO platform_admin_sessions
        (token_hash, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES ('${PLATFORM_SESSION_A}', 'staff-a', 1, 'standard',
              '2099-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO platform_admin_access_grants
        (id, platform_admin_id, tenant_id, scopes, reason, reauth_verified_at,
         issued_at, expires_at, session_token_hash)
      VALUES ('grant-a', 'staff-a', 'tenant-a', '["phi:read"]', 'support',
              '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
              '2099-01-01T00:00:00.000Z', '${PLATFORM_SESSION_A}');
    `);

    db.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-a'`).run();
    expect(db.prepare(
      `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
    ).get(TENANT_SESSION_A)).toMatchObject({ revoked_at: expect.any(String) });
    expect(() => db.prepare(
      `INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
       VALUES (?, 'tenant-a', 'staff-a', 1, 'standard',
               '2099-01-01T00:00:00.000Z', '2026-08-30T00:00:30.000Z')`,
    ).run('f'.repeat(64))).toThrow();

    db.exec(`
      UPDATE tenants SET status = 'active' WHERE id = 'tenant-a';
      INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES ('${TENANT_SESSION_B}', 'tenant-a', 'staff-a', 1, 'standard',
              '2099-01-01T00:00:00.000Z', '2026-08-30T00:01:00.000Z');
      UPDATE tenant_staff_memberships SET is_active = 0
       WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a';
    `);
    expect(db.prepare(
      `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
    ).get(TENANT_SESSION_B)).toMatchObject({ revoked_at: expect.any(String) });
    expect(() => db.prepare(
      `INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
       VALUES (?, 'tenant-a', 'staff-a', 1, 'standard',
               '2099-01-01T00:00:00.000Z', '2026-08-30T00:01:30.000Z')`,
    ).run('0'.repeat(64))).toThrow();

    db.prepare(`UPDATE platform_admins SET is_active = 0 WHERE staff_id = 'staff-a'`).run();
    expect(db.prepare(
      `SELECT revoked_at FROM platform_admin_sessions WHERE token_hash = ?`,
    ).get(PLATFORM_SESSION_A)).toMatchObject({ revoked_at: expect.any(String) });
    expect(db.prepare(
      `SELECT revoked_at FROM platform_admin_access_grants WHERE id = 'grant-a'`,
    ).get()).toMatchObject({ revoked_at: expect.any(String) });
    expect(() => db.prepare(
      `INSERT INTO platform_admin_sessions
        (token_hash, staff_id, credential_version, session_kind, expires_at, created_at)
       VALUES (?, 'staff-a', 1, 'standard',
               '2099-01-01T00:00:00.000Z', '2026-08-30T00:01:30.000Z')`,
    ).run('1'.repeat(64))).toThrow();

    db.exec(`
      UPDATE tenant_staff_memberships SET is_active = 1
       WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a';
      UPDATE platform_admins SET is_active = 1 WHERE staff_id = 'staff-a';
      INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES ('${TENANT_SESSION_C}', 'tenant-a', 'staff-a', 1, 'standard',
              '2099-01-01T00:00:00.000Z', '2026-08-30T00:02:00.000Z');
      INSERT INTO platform_admin_sessions
        (token_hash, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES ('${PLATFORM_SESSION_B}', 'staff-a', 1, 'standard',
              '2099-01-01T00:00:00.000Z', '2026-08-30T00:02:00.000Z');
      INSERT INTO platform_admin_access_grants
        (id, platform_admin_id, tenant_id, scopes, reason, reauth_verified_at,
         issued_at, expires_at, session_token_hash)
      VALUES ('grant-b', 'staff-a', 'tenant-a', '["phi:read"]', 'support',
              '2026-08-30T00:02:00.000Z', '2026-08-30T00:02:00.000Z',
              '2099-01-01T00:00:00.000Z', '${PLATFORM_SESSION_B}');
      UPDATE staff_members SET is_active = 0 WHERE id = 'staff-a';
    `);
    expect(db.prepare(
      `SELECT revoked_at FROM tenant_admin_sessions WHERE token_hash = ?`,
    ).get(TENANT_SESSION_C)).toMatchObject({ revoked_at: expect.any(String) });
    expect(db.prepare(
      `SELECT revoked_at FROM platform_admin_sessions WHERE token_hash = ?`,
    ).get(PLATFORM_SESSION_B)).toMatchObject({ revoked_at: expect.any(String) });
    expect(db.prepare(
      `SELECT revoked_at FROM platform_admin_access_grants WHERE id = 'grant-b'`,
    ).get()).toMatchObject({ revoked_at: expect.any(String) });
    expect(() => db.prepare(
      `INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
       VALUES (?, 'tenant-a', 'staff-a', 1, 'standard',
               '2099-01-01T00:00:00.000Z', '2026-08-30T00:02:30.000Z')`,
    ).run('2'.repeat(64))).toThrow();
    expect(() => db.prepare(
      `INSERT INTO platform_admin_sessions
        (token_hash, staff_id, credential_version, session_kind, expires_at, created_at)
       VALUES (?, 'staff-a', 1, 'standard',
               '2099-01-01T00:00:00.000Z', '2026-08-30T00:02:30.000Z')`,
    ).run('3'.repeat(64))).toThrow();
  });

  it('allows grants only from a live session with current platform-admin authority', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name)
      VALUES ('tenant-a', 'a', 'A');
      INSERT INTO staff_members (id, name, role, api_key)
      VALUES ('staff-a', 'Staff A', 'admin', 'key-a');
      INSERT INTO platform_admins (staff_id, is_active, created_at, updated_at)
      VALUES ('staff-a', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO platform_admin_credentials
        (staff_id, login_id, password_hash, must_change_password,
         credential_version, created_at, updated_at)
      VALUES ('staff-a', 'platform-a', 'hash', 0, 1,
              '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
      INSERT INTO platform_admin_sessions
        (token_hash, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES
        ('${PLATFORM_SESSION_A}', 'staff-a', 1, 'standard',
         '2099-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z'),
        ('${PLATFORM_SESSION_REVOKED}', 'staff-a', 1, 'standard',
         '2099-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z'),
        ('${PLATFORM_SESSION_EXPIRED}', 'staff-a', 1, 'standard',
         '2020-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z'),
        ('${PLATFORM_SESSION_STALE}', 'staff-a', 1, 'standard',
         '2099-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    `);

    expect(() => insertGrant(db, 'grant-live', PLATFORM_SESSION_A)).not.toThrow();

    db.prepare(
      `UPDATE platform_admin_sessions SET revoked_at = '2026-08-30T00:01:00.000Z'
        WHERE token_hash = ?`,
    ).run(PLATFORM_SESSION_REVOKED);
    expect(() => insertGrant(db, 'grant-revoked', PLATFORM_SESSION_REVOKED))
      .toThrow(/platform admin session authority/i);
    expect(() => insertGrant(db, 'grant-expired', PLATFORM_SESSION_EXPIRED))
      .toThrow(/platform admin session authority/i);

    db.prepare(
      `UPDATE platform_admin_credentials
          SET credential_version = 2, updated_at = '2026-08-30T00:02:00.000Z'
        WHERE staff_id = 'staff-a'`,
    ).run();
    expect(() => insertGrant(db, 'grant-stale', PLATFORM_SESSION_STALE))
      .toThrow(/platform admin session authority/i);

    db.prepare(
      `INSERT INTO platform_admin_sessions
         (token_hash, staff_id, credential_version, session_kind, expires_at, created_at)
       VALUES (?, 'staff-a', 2, 'standard', '2099-01-01T00:00:00.000Z',
               '2026-08-30T00:02:00.000Z')`,
    ).run(PLATFORM_SESSION_DISABLED);
    db.prepare(`UPDATE platform_admins SET is_active = 0 WHERE staff_id = 'staff-a'`).run();
    expect(() => insertGrant(db, 'grant-disabled-admin', PLATFORM_SESSION_DISABLED))
      .toThrow(/platform admin session authority/i);
  });
});
