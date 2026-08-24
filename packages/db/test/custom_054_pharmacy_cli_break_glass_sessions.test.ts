import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_NAME = 'custom_054_pharmacy_cli_break_glass_sessions.sql';

describe('custom_054 pharmacy CLI break-glass sessions', () => {
  it('is listed in the generated bootstrap', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
  });

  it('fixes scope to all, caps lifetime at 120 minutes, and keeps grants append-only except revocation', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE staff_members (id TEXT PRIMARY KEY);
      CREATE TABLE tenant_staff_memberships (
        tenant_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        PRIMARY KEY (tenant_id, staff_id)
      );
      CREATE TABLE platform_admins (staff_id TEXT PRIMARY KEY);
      CREATE TABLE tenant_admin_sessions (token_hash TEXT PRIMARY KEY);
      INSERT INTO tenants VALUES ('tenant-a');
      INSERT INTO staff_members VALUES ('owner-a'), ('platform-a');
      INSERT INTO tenant_staff_memberships VALUES ('tenant-a', 'owner-a');
      INSERT INTO platform_admins VALUES ('platform-a');
      INSERT INTO tenant_admin_sessions VALUES
        ('${'a'.repeat(64)}'), ('${'b'.repeat(64)}'), ('${'c'.repeat(64)}');
    `);
    db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION_NAME), 'utf8'));
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
