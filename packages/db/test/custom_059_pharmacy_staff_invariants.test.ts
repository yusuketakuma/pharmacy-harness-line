import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.exec(`
    INSERT INTO tenants (id, tenant_code, display_name, status)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'active');
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'channel-a', 'Account A', 'token-a', 'secret-a');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id)
    VALUES ('tenant-a', 'account-a');
    INSERT INTO staff_members (id, name, role, api_key)
    VALUES ('owner-a', 'Owner A', 'owner', 'key-a'),
           ('owner-b', 'Owner B', 'owner', 'key-b'),
           ('staff-a', 'Staff A', 'staff', 'key-c'),
           ('staff-b', 'Staff B', 'staff', 'key-d');
    INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active)
    VALUES ('tenant-a', 'owner-a', 'owner', 1),
           ('tenant-a', 'owner-b', 'owner', 1),
           ('tenant-a', 'staff-a', 'staff', 1),
           ('tenant-a', 'staff-b', 'staff', 1);
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES ('account-a', 'staff-a', 1, '2026-08-25', '2026-08-25'),
           ('account-a', 'staff-b', 1, '2026-08-25', '2026-08-25');
  `);
  return db;
}

describe('custom_059 pharmacy staff invariants', () => {
  it('serializes concurrent owner removal at the database write boundary', () => {
    const db = database();

    expect(db.prepare(`UPDATE tenant_staff_memberships
      SET is_active = 0 WHERE tenant_id = 'tenant-a' AND staff_id = 'owner-a'`).run().changes)
      .toBe(1);
    expect(() => db.prepare(`UPDATE tenant_staff_memberships
      SET role = 'admin' WHERE tenant_id = 'tenant-a' AND staff_id = 'owner-b'`).run())
      .toThrow(/PHARMACY_LAST_ACTIVE_OWNER/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM tenant_staff_memberships
      WHERE tenant_id = 'tenant-a' AND role = 'owner' AND is_active = 1`).get())
      .toEqual({ count: 1 });
  });

  it('serializes concurrent account-assignee removal at the database write boundary', () => {
    const db = database();

    expect(db.prepare(`UPDATE pharmacy_staff_accounts
      SET is_active = 0 WHERE line_account_id = 'account-a' AND staff_id = 'staff-a'`).run().changes)
      .toBe(1);
    expect(() => db.prepare(`UPDATE pharmacy_staff_accounts
      SET is_active = 0 WHERE line_account_id = 'account-a' AND staff_id = 'staff-b'`).run())
      .toThrow(/PHARMACY_LAST_ACTIVE_ACCOUNT_ASSIGNEE/);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_staff_accounts AS assignment
      INNER JOIN tenant_staff_memberships AS membership ON membership.staff_id = assignment.staff_id
      WHERE assignment.line_account_id = 'account-a'
        AND assignment.is_active = 1 AND membership.is_active = 1`).get())
      .toEqual({ count: 1 });
  });

  it('rejects deactivating the sole active assignee through the membership row', () => {
    const db = database();
    db.prepare(`UPDATE pharmacy_staff_accounts SET is_active = 0
      WHERE line_account_id = 'account-a' AND staff_id = 'staff-b'`).run();

    expect(() => db.prepare(`UPDATE tenant_staff_memberships
      SET is_active = 0 WHERE tenant_id = 'tenant-a' AND staff_id = 'staff-a'`).run())
      .toThrow(/PHARMACY_LAST_ACTIVE_ACCOUNT_ASSIGNEE/);
  });
});
