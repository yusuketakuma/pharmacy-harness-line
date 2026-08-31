import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-24T00:00:00.000Z';

describe('custom_058 pharmacy incoming image disposition', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'A', 'active', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(NOW, NOW);
  });

  it('records explicit orphan/missing/unknown dispositions while keeping keys internal', () => {
    const key = 'tenants/tenant-a/accounts/account-a/incoming/internal.jpg';
    db.prepare(`INSERT INTO pharmacy_incoming_image_dispositions
      (r2_key, tenant_id, line_account_id, message_id, status, source, reason_code,
       hold_epoch, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'internal-message', 'ORPHAN', 'r2_inventory',
       'r2_untracked', 0, ?, ?)`).run(key, NOW, NOW);
    db.prepare(`UPDATE pharmacy_incoming_image_dispositions
      SET status = 'UNKNOWN', reason_code = 'stored_at_unknown' WHERE r2_key = ?`).run(key);
    expect(db.prepare(
      `SELECT status, reason_code FROM pharmacy_incoming_image_dispositions WHERE r2_key = ?`,
    ).get(key)).toEqual({ status: 'UNKNOWN', reason_code: 'stored_at_unknown' });
    const columns = (db.prepare('PRAGMA table_info(pharmacy_incoming_image_dispositions)')
      .all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).not.toEqual(expect.arrayContaining(['patient_name', 'raw_content']));
  });

  it('rejects an invalid disposition status at the database boundary', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_incoming_image_dispositions
      (r2_key, tenant_id, line_account_id, message_id, status, source, reason_code,
       hold_epoch, created_at, updated_at)
      VALUES ('key', 'tenant-a', 'account-a', 'message', 'DELETE', 'r2_inventory',
       'bad', 0, ?, ?)`).run(NOW, NOW)).toThrow(/CHECK constraint failed/i);
  });
});
