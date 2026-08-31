import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteStaffMember } from '../src/staff.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.exec(`
    INSERT INTO tenants (id, tenant_code, display_name) VALUES
      ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
    INSERT INTO staff_members (id, name, role, api_key) VALUES
      ('staff-a', 'A', 'owner', 'key-a'), ('staff-b', 'B', 'owner', 'key-b');
    INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role) VALUES
      ('tenant-a', 'staff-a', 'owner'), ('tenant-b', 'staff-b', 'owner');
    INSERT INTO tenant_admin_credentials
      (tenant_id, staff_id, login_id, password_hash, must_change_password,
       credential_version, created_at, updated_at)
    VALUES ('tenant-a', 'staff-a', 'admin-a', 'hash', 1, 1, '2026-08-18', '2026-08-18');
    INSERT INTO pharmacy_tenant_admin_bootstraps (tenant_id, staff_id, created_at)
    VALUES ('tenant-a', 'staff-a', '2026-08-18');
  `);
  return db;
}

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => ({
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
    }) as D1Result,
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

describe('custom_019_pharmacy_tenant_admin_bootstrap.sql', () => {
  it('permits only one bootstrap owner per tenant', () => {
    const db = database();

    expect(db.prepare(
      'SELECT tenant_id, staff_id FROM pharmacy_tenant_admin_bootstraps ORDER BY tenant_id',
    ).all()).toEqual([{ tenant_id: 'tenant-a', staff_id: 'staff-a' }]);
    expect(() => db.prepare(
      `INSERT INTO pharmacy_tenant_admin_bootstraps (tenant_id, staff_id, created_at)
       VALUES ('tenant-a', 'staff-a', '2026-08-18T00:00:00.000Z')`,
    ).run()).toThrow(/UNIQUE constraint failed/i);
    expect(() => db.prepare(
      `INSERT INTO pharmacy_tenant_admin_bootstraps (tenant_id, staff_id, created_at)
       VALUES ('tenant-b', 'staff-b', '2026-08-18T00:00:00.000Z')`,
    ).run()).not.toThrow();

  });

  it('fails closed instead of physically deleting a staff lifecycle record', async () => {
    const db = database();

    await expect(deleteStaffMember(d1From(db), 'staff-a')).rejects.toThrow(
      'Physical staff deletion is disabled; deactivate the tenant membership instead',
    );
    expect(db.prepare(
      'SELECT staff_id FROM pharmacy_tenant_admin_bootstraps WHERE tenant_id = \'tenant-a\'',
    ).get()).toEqual({ staff_id: 'staff-a' });
    expect(db.prepare(
      'SELECT id FROM staff_members WHERE id = \'staff-a\'',
    ).get()).toEqual({ id: 'staff-a' });
  });
});
