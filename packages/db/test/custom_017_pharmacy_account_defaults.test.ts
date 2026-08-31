import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
describe('custom_017_pharmacy_account_defaults.sql', () => {
  it('defaults every new LINE account to pharmacy mode', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account', 'channel', 'Account', 'token', 'secret')`).run();

    expect(db.prepare(`SELECT line_account_id, mode
      FROM pharmacy_account_capabilities
      WHERE line_account_id = 'account'`).get()).toEqual({
      line_account_id: 'account',
      mode: 'pharmacy',
    });
  });
});
