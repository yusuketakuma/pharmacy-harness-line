import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_017_pharmacy_account_defaults.sql');

describe('custom_017_pharmacy_account_defaults.sql', () => {
  it('backfills and defaults every LINE account to pharmacy mode', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('before', 'channel-before', 'Before', 'token', 'secret')`).run();
    db.prepare(`DELETE FROM pharmacy_account_capabilities
      WHERE line_account_id = 'before'`).run();

    const migration = readFileSync(MIGRATION, 'utf8');
    db.exec(migration);
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('after', 'channel-after', 'After', 'token', 'secret')`).run();

    expect(db.prepare(`SELECT line_account_id, mode
      FROM pharmacy_account_capabilities
      WHERE line_account_id IN ('before', 'after')
      ORDER BY line_account_id`).all()).toEqual([
      { line_account_id: 'after', mode: 'pharmacy' },
      { line_account_id: 'before', mode: 'pharmacy' },
    ]);
    expect(() => db.exec(migration)).not.toThrow();
  });
});
