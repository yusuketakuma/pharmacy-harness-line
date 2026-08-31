import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_021 pharmacy webhook event receipts', () => {
  it('enforces tenant/account-scoped idempotency', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name, created_at, updated_at)
      VALUES ('tenant-a', 'a', 'A', '2026-08-19', '2026-08-19');
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', '2026-08-19', '2026-08-19');
    `);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO pharmacy_webhook_event_receipts
        (tenant_id, line_account_id, webhook_event_id, received_at)
      VALUES (?, ?, ?, ?)
    `);
    expect(insert.run('tenant-a', 'account-a', 'event-1', '2026-08-19').changes).toBe(1);
    expect(insert.run('tenant-a', 'account-a', 'event-1', '2026-08-19').changes).toBe(0);
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM pharmacy_webhook_event_receipts`,
    ).get()).toEqual({ count: 1 });
    expect(() => insert.run('tenant-other', 'account-a', 'event-1', '2026-08-19'))
      .toThrow(/FOREIGN KEY constraint failed/i);
  });
});
