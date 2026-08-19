import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { updateStaffMember } from '../src/staff.js';

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { meta: { changes: result.changes } } as D1Result;
    },
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE staff_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tenant_staff_memberships (
      tenant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL
    );
  `);
}

describe('updateStaffMember tenant profile scope', () => {
  it('does not update a profile shared with another tenant', async () => {
    const sqlite = new Database(':memory:');
    schema(sqlite);
    sqlite.prepare(`INSERT INTO staff_members
      (id, name, role, api_key, is_active, created_at, updated_at)
      VALUES ('staff-a', 'Shared Staff', 'staff', 'disabled:key', 1, 'now', 'now')`).run();
    sqlite.prepare(`INSERT INTO tenant_staff_memberships (tenant_id, staff_id)
      VALUES ('tenant-a', 'staff-a'), ('tenant-b', 'staff-a')`).run();

    const result = await updateStaffMember(
      d1From(sqlite),
      'staff-a',
      { name: 'Tenant A Staff' },
      'tenant-a',
    );

    expect(result).toBeNull();
    expect(sqlite.prepare(`SELECT name FROM staff_members WHERE id = 'staff-a'`).get())
      .toEqual({ name: 'Shared Staff' });
  });

  it('updates a profile when the authenticated tenant is its only membership', async () => {
    const sqlite = new Database(':memory:');
    schema(sqlite);
    sqlite.prepare(`INSERT INTO staff_members
      (id, name, role, api_key, is_active, created_at, updated_at)
      VALUES ('staff-a', 'Staff', 'staff', 'disabled:key', 1, 'now', 'now')`).run();
    sqlite.prepare(`INSERT INTO tenant_staff_memberships (tenant_id, staff_id)
      VALUES ('tenant-a', 'staff-a')`).run();

    const result = await updateStaffMember(
      d1From(sqlite),
      'staff-a',
      { name: 'Updated Staff' },
      'tenant-a',
    );

    expect(result?.name).toBe('Updated Staff');
  });
});
