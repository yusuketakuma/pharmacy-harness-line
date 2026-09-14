import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-09-14T00:00:00.000Z';

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
      ('staff-c', 'Staff C', 'staff', 'disabled:staff-c', 1, 'human', '${NOW}', '${NOW}');
    INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES
      ('tenant-a', 'staff-a', 'staff', 1, '${NOW}', '${NOW}'),
      ('tenant-b', 'staff-b', 'staff', 1, '${NOW}', '${NOW}'),
      ('tenant-a', 'staff-c', 'staff', 0, '${NOW}', '${NOW}');
    INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES
      ('account-a', 'staff-a', 1, '${NOW}', '${NOW}'),
      ('account-b', 'staff-b', 1, '${NOW}', '${NOW}'),
      ('account-a', 'staff-c', 1, '${NOW}', '${NOW}');
  `);
  return sqlite;
}

function insertOperation(
  sqlite: Database.Database,
  accountId: string,
  primaryStaffId: string,
  backupStaffId: string | null = null,
  enabled = 0,
): void {
  sqlite.prepare(`
    INSERT INTO pharmacy_medication_followup_operations
      (line_account_id, service_hours_text, response_sla_json,
       primary_staff_id, backup_staff_id, after_hours_message_code,
       emergency_message_code, enabled, version, created_at, updated_at)
    VALUES (?, '未定', '{}', ?, ?, 'contact_pharmacy_during_hours',
            'seek_urgent_care', ?, 1, ?, ?)
  `).run(accountId, primaryStaffId, backupStaffId, enabled, NOW, NOW);
}

describe('custom_076 pharmacy follow-up operations scope', () => {
  it('rejects cross-tenant primary and backup staff references on insert/update', () => {
    const sqlite = setup();

    expect(() => insertOperation(sqlite, 'account-a', 'staff-b'))
      .toThrow(/PHARMACY_FOLLOWUP_OPERATION_STAFF_SCOPE_MISMATCH/);
    insertOperation(sqlite, 'account-a', 'staff-a');
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_medication_followup_operations
         SET backup_staff_id = 'staff-b'
       WHERE line_account_id = 'account-a'
    `).run()).toThrow(/PHARMACY_FOLLOWUP_OPERATION_STAFF_SCOPE_MISMATCH/);
    expect(() => sqlite.prepare(`
      UPDATE pharmacy_medication_followup_operations
         SET line_account_id = 'account-b'
       WHERE line_account_id = 'account-a'
    `).run()).toThrow(/PHARMACY_FOLLOWUP_OPERATION_STAFF_SCOPE_MISMATCH/);
  });

  it('permits disabled preconfiguration but requires active human staff before enabling', () => {
    const sqlite = setup();
    insertOperation(sqlite, 'account-a', 'staff-c');

    expect(() => sqlite.prepare(`
      UPDATE pharmacy_medication_followup_operations
         SET enabled = 1
       WHERE line_account_id = 'account-a'
    `).run()).toThrow(/PHARMACY_FOLLOWUP_OPERATION_ENABLED_STAFF_INVALID/);

    sqlite.prepare(`
      UPDATE pharmacy_medication_followup_operations
         SET primary_staff_id = 'staff-a', enabled = 1
       WHERE line_account_id = 'account-a'
    `).run();
    expect(sqlite.prepare(`
      SELECT enabled FROM pharmacy_medication_followup_operations
       WHERE line_account_id = 'account-a'
    `).get()).toEqual({ enabled: 1 });
  });

  it('keeps the existing table additive and allows a null backup', () => {
    const sqlite = setup();
    insertOperation(sqlite, 'account-a', 'staff-a');
    expect(sqlite.prepare(`
      SELECT primary_staff_id, backup_staff_id FROM pharmacy_medication_followup_operations
       WHERE line_account_id = 'account-a'
    `).get()).toEqual({ primary_staff_id: 'staff-a', backup_staff_id: null });

    const triggers = sqlite.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'pharmacy_followup_operations_%'
       ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(triggers.map(({ name }) => name)).toEqual([
      'pharmacy_followup_operations_enabled_staff_insert',
      'pharmacy_followup_operations_enabled_staff_update',
      'pharmacy_followup_operations_staff_scope_insert',
      'pharmacy_followup_operations_staff_scope_update',
    ]);
  });
});
