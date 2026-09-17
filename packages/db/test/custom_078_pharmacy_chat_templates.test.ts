import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-09-17T00:00:00.000Z';

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES
      ('tenant-a', 'pharmacy-a', 'Pharmacy A', 'active', '${NOW}', '${NOW}'),
      ('tenant-b', 'pharmacy-b', 'Pharmacy B', 'active', '${NOW}', '${NOW}');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES
      ('account-a', 'channel-a', 'Account A', 'token-a', 'secret-a', '${NOW}', '${NOW}'),
      ('account-b', 'channel-b', 'Account B', 'token-b', 'secret-b', '${NOW}', '${NOW}');
    INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
    VALUES
      ('tenant-a', 'account-a', '${NOW}', '${NOW}'),
      ('tenant-b', 'account-b', '${NOW}', '${NOW}');
    INSERT INTO staff_members
      (id, name, role, api_key, is_active, principal_kind, created_at, updated_at)
    VALUES
      ('staff-a', 'Staff A', 'staff', 'disabled:staff-a', 1, 'human', '${NOW}', '${NOW}'),
      ('staff-b', 'Staff B', 'staff', 'disabled:staff-b', 1, 'human', '${NOW}', '${NOW}'),
      ('staff-c', 'Staff C', 'staff', 'disabled:staff-c', 0, 'human', '${NOW}', '${NOW}');
    INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES
      ('tenant-a', 'staff-a', 'staff', 1, '${NOW}', '${NOW}'),
      ('tenant-b', 'staff-b', 'staff', 1, '${NOW}', '${NOW}'),
      ('tenant-a', 'staff-c', 'staff', 1, '${NOW}', '${NOW}');
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES
      ('account-a', 'staff-a', 1, '${NOW}', '${NOW}'),
      ('account-b', 'staff-b', 1, '${NOW}', '${NOW}'),
      ('account-a', 'staff-c', 1, '${NOW}', '${NOW}');
  `);
  return sqlite;
}

describe('custom_078 pharmacy_chat_templates', () => {
  it('accepts a scoped draft template', () => {
    const sqlite = setup();
    sqlite.prepare(`
      INSERT INTO pharmacy_chat_templates
        (line_account_id, template_id, title, body, status, version,
         created_by_staff_id, created_at, updated_at)
      VALUES ('account-a', 'tpl-00001', '受付確認', '処方せんを受け付けました。', 'draft', 1,
              'staff-a', '${NOW}', '${NOW}')
    `).run();
    const row = sqlite.prepare(
      `SELECT status, version FROM pharmacy_chat_templates
        WHERE line_account_id = 'account-a' AND template_id = 'tpl-00001'`,
    ).get() as { status: string; version: number };
    expect(row.status).toBe('draft');
    expect(row.version).toBe(1);
  });

  it('rejects a creator scoped to another tenant', () => {
    const sqlite = setup();
    expect(() => sqlite.prepare(`
      INSERT INTO pharmacy_chat_templates
        (line_account_id, template_id, title, body, status, version,
         created_by_staff_id, created_at, updated_at)
      VALUES ('account-a', 'tpl-00001', 't', '本文', 'draft', 1,
              'staff-b', '${NOW}', '${NOW}')
    `).run()).toThrow(/PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH/);
  });

  it('rejects an inactive creator even within the account scope', () => {
    const sqlite = setup();
    expect(() => sqlite.prepare(`
      INSERT INTO pharmacy_chat_templates
        (line_account_id, template_id, title, body, status, version,
         created_by_staff_id, created_at, updated_at)
      VALUES ('account-a', 'tpl-00001', 't', '本文', 'draft', 1,
              'staff-c', '${NOW}', '${NOW}')
    `).run()).toThrow(/PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH/);
  });

  it('requires approver fields when approved and forbids self-approval', () => {
    const sqlite = setup();
    sqlite.prepare(`
      INSERT INTO pharmacy_chat_templates
        (line_account_id, template_id, title, body, status, version,
         created_by_staff_id, created_at, updated_at)
      VALUES ('account-a', 'tpl-00001', 't', '本文', 'draft', 1,
              'staff-a', '${NOW}', '${NOW}')
    `).run();
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_chat_templates
         SET status = 'approved'
       WHERE line_account_id = 'account-a' AND template_id = 'tpl-00001'
    `).run()).toThrow();
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_chat_templates
         SET status = 'approved', approved_by_staff_id = 'staff-a',
             approved_at = '${NOW}'
       WHERE line_account_id = 'account-a' AND template_id = 'tpl-00001'
    `).run()).toThrow();
  });

  it('rejects approver outside the account scope', () => {
    const sqlite = setup();
    sqlite.prepare(`
      INSERT INTO pharmacy_chat_templates
        (line_account_id, template_id, title, body, status, version,
         created_by_staff_id, created_at, updated_at)
      VALUES ('account-a', 'tpl-00001', 't', '本文', 'draft', 1,
              'staff-a', '${NOW}', '${NOW}')
    `).run();
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_chat_templates
         SET status = 'approved', approved_by_staff_id = 'staff-b',
             approved_at = '${NOW}'
       WHERE line_account_id = 'account-a' AND template_id = 'tpl-00001'
    `).run()).toThrow(/PHARMACY_CHAT_TEMPLATE_STAFF_SCOPE_MISMATCH/);
  });

  it('keeps identity columns immutable', () => {
    const sqlite = setup();
    sqlite.prepare(`
      INSERT INTO pharmacy_chat_templates
        (line_account_id, template_id, title, body, status, version,
         created_by_staff_id, created_at, updated_at)
      VALUES ('account-a', 'tpl-00001', 't', '本文', 'draft', 1,
              'staff-a', '${NOW}', '${NOW}')
    `).run();
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_chat_templates
         SET template_id = 'tpl-00002'
       WHERE line_account_id = 'account-a' AND template_id = 'tpl-00001'
    `).run()).toThrow(/PHARMACY_CHAT_TEMPLATE_IDENTITY_IMMUTABLE/);
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_chat_templates
         SET created_at = '2030-01-01T00:00:00.000Z'
       WHERE line_account_id = 'account-a' AND template_id = 'tpl-00001'
    `).run()).toThrow(/PHARMACY_CHAT_TEMPLATE_IDENTITY_IMMUTABLE/);
  });
});
