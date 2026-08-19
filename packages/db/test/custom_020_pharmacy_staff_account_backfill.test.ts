import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_020 pharmacy staff account backfill', () => {
  it('is tenant-scoped and idempotent', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'a', 'A', 'active', '2026-08-19', '2026-08-19'),
             ('tenant-b', 'b', 'B', 'active', '2026-08-19', '2026-08-19');
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
             ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', '2026-08-19', '2026-08-19'),
             ('tenant-b', 'account-b', '2026-08-19', '2026-08-19');
      INSERT INTO staff_members (id, name, role, api_key, created_at, updated_at)
      VALUES ('staff-a', 'A', 'staff', 'key-a', '2026-08-19', '2026-08-19'),
             ('staff-b', 'B', 'staff', 'key-b', '2026-08-19', '2026-08-19');
      INSERT INTO tenant_staff_memberships
        (tenant_id, staff_id, role, is_active, created_at, updated_at)
      VALUES ('tenant-a', 'staff-a', 'staff', 1, '2026-08-19', '2026-08-19'),
             ('tenant-b', 'staff-b', 'staff', 1, '2026-08-19', '2026-08-19');
    `);

    const migration = readFileSync(
      join(ROOT, 'migrations', 'custom_020_pharmacy_staff_account_backfill.sql'),
      'utf8',
    );
    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
    expect(db.prepare(
      `SELECT line_account_id, staff_id FROM pharmacy_staff_accounts ORDER BY line_account_id`,
    ).all()).toEqual([
      { line_account_id: 'account-a', staff_id: 'staff-a' },
      { line_account_id: 'account-b', staff_id: 'staff-b' },
    ]);
  });
});
