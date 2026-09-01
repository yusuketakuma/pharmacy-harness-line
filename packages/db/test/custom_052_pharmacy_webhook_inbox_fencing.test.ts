import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
describe('custom_052 pharmacy webhook inbox fencing', () => {
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

  it('keeps the claim token nullable', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES ('tenant-a', 'a', 'A');
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a', 'channel-a', 'A', 'token', 'secret');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES ('tenant-a', 'account-a');
    `);
    db.prepare(`INSERT INTO pharmacy_webhook_event_receipts
      (tenant_id, line_account_id, webhook_event_id, status, received_at)
      VALUES ('tenant-a', 'account-a', 'event-a', 'processing', '2026-08-23T00:00:00Z')`).run();

    expect(db.prepare(`SELECT status, claim_token FROM pharmacy_webhook_event_receipts`).get())
      .toEqual({ status: 'processing', claim_token: null });
  });
});
