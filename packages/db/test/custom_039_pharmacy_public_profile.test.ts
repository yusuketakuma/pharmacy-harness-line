import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-20T00:00:00.000Z';

function seed(db: Database.Database, suffix: 'a' | 'b') {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `account-${suffix}`, `channel-${suffix}`, `薬局${suffix}`, `token-${suffix}`, `secret-${suffix}`, NOW, NOW,
  );
  db.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', ?, 1, ?, ?)`).run(`staff-${suffix}`, suffix, `key-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, suffix, suffix, NOW, NOW);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', 1, ?, ?)`).run(`tenant-${suffix}`, `staff-${suffix}`, NOW, NOW);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, NOW, NOW);
}

function insert(db: Database.Database, account: string, staff: string) {
  return db.prepare(`INSERT INTO pharmacy_public_profiles
    (line_account_id, display_name, address, business_hours, updated_by, created_at, updated_at)
    VALUES (?, 'みどり薬局', '東京都千代田区', '月〜金 9:00〜18:00', ?, ?, ?)`)
    .run(account, staff, NOW, NOW);
}

describe('custom_039 pharmacy public profile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seed(db, 'a');
    seed(db, 'b');
  });

  it('stores one public profile per LINE account', () => {
    insert(db, 'account-a', 'staff-a');
    expect(db.prepare(`SELECT display_name FROM pharmacy_public_profiles WHERE line_account_id = ?`)
      .get('account-a')).toEqual({ display_name: 'みどり薬局' });
    expect(() => insert(db, 'account-a', 'staff-a')).toThrow(/unique/i);
  });

  it('rejects an editor assigned only to another account', () => {
    expect(() => insert(db, 'account-a', 'staff-b')).toThrow(/foreign key/i);
  });

  it('cascades the public profile with its LINE account', () => {
    insert(db, 'account-a', 'staff-a');
    db.prepare(`DELETE FROM line_accounts WHERE id = ?`).run('account-a');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_public_profiles`).get())
      .toEqual({ count: 0 });
  });
});
