import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_NAME = 'custom_052_pharmacy_webhook_inbox_fencing.sql';

describe('custom_052 pharmacy webhook inbox fencing', () => {
  it('is listed in the generated bootstrap', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
  });

  it('adds a nullable claim token without rewriting existing receipts', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE pharmacy_webhook_event_receipts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      webhook_event_id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (tenant_id, line_account_id, webhook_event_id)
    )`);
    db.prepare(`INSERT INTO pharmacy_webhook_event_receipts
      (tenant_id, line_account_id, webhook_event_id, status)
      VALUES ('tenant-a', 'account-a', 'event-a', 'processing')`).run();

    db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION_NAME), 'utf8'));

    expect(db.prepare(`SELECT status, claim_token FROM pharmacy_webhook_event_receipts`).get())
      .toEqual({ status: 'processing', claim_token: null });
  });
});
