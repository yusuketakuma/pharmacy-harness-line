import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function setup(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
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
    expect(meta.includedMigrations).toEqual([
      '001_v033_baseline.sql',
      '002_custom_060_messages_log_account_date.sql',
      '003_outbound_line_deliveries.sql',
      '004_custom_061_generic_resource_tenant_scope.sql',
      '005_custom_062_ref_tracking_tenant_scope.sql',
      '006_custom_063_auth_disable_revocation.sql',
      '007_custom_064_legacy_access_grant_drain.sql',
      '008_custom_065_session_rotation_family.sql',
      '009_custom_066_auth_session_activity.sql',
      '010_custom_067_admin_login_throttles.sql',
      '011_custom_068_patient_proxy_controls.sql',
      '012_custom_069_patient_control_audit.sql',
      '013_custom_070_patient_proxy_lifecycle.sql',
    ]);
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
