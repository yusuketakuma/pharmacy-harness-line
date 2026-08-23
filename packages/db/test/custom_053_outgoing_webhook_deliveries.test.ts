import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_NAME = 'custom_053_outgoing_webhook_deliveries.sql';

describe('custom_053 outgoing webhook deliveries', () => {
  it('is listed in the generated bootstrap', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
  });

  it('keeps delivery attempts tenant-scoped and outcome-constrained', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY);
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
      CREATE TABLE tenant_line_accounts (
        tenant_id TEXT NOT NULL,
        line_account_id TEXT NOT NULL UNIQUE,
        PRIMARY KEY (tenant_id, line_account_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
      );
      INSERT INTO tenants VALUES ('tenant-a'), ('tenant-b');
      INSERT INTO line_accounts VALUES ('account-a'), ('account-b');
      INSERT INTO tenant_line_accounts VALUES ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
    `);
    db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION_NAME), 'utf8'));

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
