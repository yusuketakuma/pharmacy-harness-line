import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteStaffMember } from '../src/staff.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', 'custom_019_pharmacy_tenant_admin_bootstrap.sql');

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE staff_members (id TEXT PRIMARY KEY);
    CREATE TABLE tenant_staff_memberships (
      tenant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, staff_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (staff_id) REFERENCES staff_members(id) ON DELETE CASCADE
    );
    CREATE TABLE tenant_admin_credentials (
      tenant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, staff_id),
      FOREIGN KEY (tenant_id, staff_id)
        REFERENCES tenant_staff_memberships(tenant_id, staff_id) ON DELETE CASCADE
    );
    INSERT INTO tenants VALUES ('tenant-a'), ('tenant-b');
    INSERT INTO staff_members VALUES ('staff-a'), ('staff-b');
    INSERT INTO tenant_staff_memberships VALUES
      ('tenant-a', 'staff-a'), ('tenant-b', 'staff-b');
    INSERT INTO tenant_admin_credentials VALUES ('tenant-a', 'staff-a');
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
  it('backfills existing credentials and permits only one bootstrap owner per tenant', () => {
    const db = database();
    const migration = readFileSync(MIGRATION, 'utf8');
    db.exec(migration);

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

    expect(() => db.exec(migration)).not.toThrow();
  });

  it('fails closed instead of physically deleting a staff lifecycle record', async () => {
    const db = database();
    db.exec(readFileSync(MIGRATION, 'utf8'));

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
