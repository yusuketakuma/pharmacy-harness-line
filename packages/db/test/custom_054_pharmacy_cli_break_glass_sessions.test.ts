import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
describe('custom_054 pharmacy CLI break-glass sessions', () => {
  it('is listed in the generated bootstrap', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toEqual([
      '001_v033_baseline.sql',
      '002_custom_060_messages_log_account_date.sql',
      '003_outbound_line_deliveries.sql',
      '004_custom_061_generic_resource_tenant_scope.sql',
      '005_custom_062_ref_tracking_tenant_scope.sql',
      '006_custom_063_auth_disable_revocation.sql',
      '007_custom_064_legacy_access_grant_drain.sql',
      '008_custom_065_session_rotation_family.sql',
    ]);
  });

  it('fixes scope to all, caps lifetime at 120 minutes, and keeps grants append-only except revocation', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES ('tenant-a', 'a', 'A');
      INSERT INTO staff_members (id, name, role, api_key) VALUES
        ('owner-a', 'Owner', 'owner', 'owner-key'),
        ('platform-a', 'Platform', 'admin', 'platform-key');
      INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role)
      VALUES ('tenant-a', 'owner-a', 'owner');
      INSERT INTO platform_admins (staff_id, created_at, updated_at)
      VALUES ('platform-a', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
      INSERT INTO tenant_admin_credentials
        (tenant_id, staff_id, login_id, password_hash, credential_version, created_at, updated_at)
      VALUES ('tenant-a', 'owner-a', 'owner-a', 'hash', 1,
              '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
      INSERT INTO tenant_admin_sessions
        (token_hash, tenant_id, staff_id, credential_version, session_kind, expires_at, created_at)
      VALUES
        ('${'a'.repeat(64)}', 'tenant-a', 'owner-a', 1, 'standard', '2026-08-24T03:00:00.000Z', '2026-08-24T00:00:00.000Z'),
        ('${'b'.repeat(64)}', 'tenant-a', 'owner-a', 1, 'standard', '2026-08-24T03:00:00.000Z', '2026-08-24T00:00:00.000Z'),
        ('${'c'.repeat(64)}', 'tenant-a', 'owner-a', 1, 'standard', '2026-08-24T03:00:00.000Z', '2026-08-24T00:00:00.000Z');
    `);
    const insert = db.prepare(`INSERT INTO pharmacy_cli_break_glass_sessions
      (id, token_hash, platform_admin_id, tenant_id, staff_id, operation_scope,
       reason, ticket_reference, issued_at, expires_at, revoked_at, revoked_by)
      VALUES (?, ?, 'platform-a', 'tenant-a', 'owner-a', ?, 'incident recovery', NULL,
              '2026-08-24T00:00:00.000Z', ?, NULL, NULL)`);

    expect(insert.run('session-a', 'a'.repeat(64), 'all', '2026-08-24T02:00:00.000Z').changes).toBe(1);
    expect(() => insert.run('session-b', 'b'.repeat(64), 'read', '2026-08-24T02:00:00.000Z'))
      .toThrow(/check/i);
    expect(() => insert.run('session-c', 'c'.repeat(64), 'all', '2026-08-24T02:00:01.000Z'))
      .toThrow(/check/i);
    expect(() => db.prepare(`UPDATE pharmacy_cli_break_glass_sessions SET reason = 'changed'`).run())
      .toThrow(/immutable/i);
    expect(db.prepare(`UPDATE pharmacy_cli_break_glass_sessions
      SET revoked_at = '2026-08-24T01:00:00.000Z', revoked_by = 'platform-a'
      WHERE id = 'session-a'`).run().changes).toBe(1);
    expect(() => db.prepare('DELETE FROM pharmacy_cli_break_glass_sessions').run())
      .toThrow(/immutable/i);
  });
});
