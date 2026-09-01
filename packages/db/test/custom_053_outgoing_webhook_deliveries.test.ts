import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
describe('custom_053 outgoing webhook deliveries', () => {
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
    ]);
  });

  it('keeps delivery attempts tenant-scoped and outcome-constrained', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES
        ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES
        ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
        ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES
        ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
    `);

    const insert = db.prepare(`INSERT INTO outgoing_webhook_deliveries
      (id, tenant_id, line_account_id, target_type, target_id, event_type,
       outcome, claim_token, attempt_count, attempted_at, created_at, updated_at)
      VALUES (?, ?, ?, 'configured', 'webhook-a', 'message_received',
              'attempted', 'claim-a', 1, '2026-08-23T00:00:00.000+09:00',
              '2026-08-23T00:00:00.000+09:00', '2026-08-23T00:00:00.000+09:00')`);

    insert.run('delivery-a', 'tenant-a', 'account-a');
    expect(() => insert.run('delivery-a', 'tenant-a', 'account-a')).toThrow();
    expect(() => insert.run('delivery-b', 'tenant-a', 'account-b')).toThrow();
    expect(() => db.prepare(`UPDATE outgoing_webhook_deliveries SET outcome = 'unknown' WHERE id = ?`)
      .run('delivery-a')).toThrow();
  });
});
