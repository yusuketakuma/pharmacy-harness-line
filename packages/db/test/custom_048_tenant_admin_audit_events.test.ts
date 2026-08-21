import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_048_tenant_admin_audit_events.sql');

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

const insert = (db: Database.Database, tenantId: string | null, accountId: string | null) =>
  db.prepare(`INSERT INTO tenant_admin_audit_events
    (id, tenant_id, line_account_id, actor_staff_id, action, resource_type, resource_id,
     detail_json, created_at)
    VALUES (?, ?, ?, 'staff-a', 'staff.reset_password', 'staff', 'staff-b', NULL,
            '2026-08-21T00:00:00Z')`).run(crypto.randomUUID(), tenantId, accountId);

describe('custom_048 tenant admin audit events', () => {
  it('is listed in the generated bootstrap', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toContain('custom_048_tenant_admin_audit_events.sql');
  });

  it('requires a tenant or account scope and keeps rows append-only', () => {
    const db = setup();
    expect(insert(db, 'tenant-a', null).changes).toBe(1);
    expect(insert(db, null, 'account-a').changes).toBe(1);
    expect(() => insert(db, null, null)).toThrow(/check/i);
    expect(() => db.prepare(`UPDATE tenant_admin_audit_events SET action = 'x'`).run())
      .toThrow(/immutable/i);
    expect(() => db.prepare(`DELETE FROM tenant_admin_audit_events`).run())
      .toThrow(/immutable/i);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM tenant_admin_audit_events
      WHERE tenant_id = 'tenant-a'`).get()).toEqual({ count: 1 });
  });
});
