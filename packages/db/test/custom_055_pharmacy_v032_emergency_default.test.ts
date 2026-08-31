import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function capabilities(db: Database.Database, accountId: string): string[] {
  const row = db.prepare(`SELECT capabilities_json FROM pharmacy_account_capabilities
    WHERE line_account_id = ?`).get(accountId) as { capabilities_json: string };
  return JSON.parse(row.capabilities_json) as string[];
}

describe('custom_055 pharmacy v0.32 emergency default', () => {
  it('enables emergency contraception for a newly created account only', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('new-account', 'new-channel', 'New', 'token', 'secret')`).run();

    expect(capabilities(db, 'new-account')).toContain('emergency_contraception');
    expect(capabilities(db, 'new-account')).not.toContain('electronic_prescription');
  });

  it('preserves an existing explicit OFF when another account is created', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('existing-account', 'existing-channel', 'Existing', 'token', 'secret')`).run();
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = (SELECT json_group_array(value)
        FROM json_each(capabilities_json) WHERE value <> 'emergency_contraception')
      WHERE line_account_id = 'existing-account'`).run();

    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('other-account', 'other-channel', 'Other', 'token', 'secret')`).run();

    expect(capabilities(db, 'existing-account')).not.toContain('emergency_contraception');
  });
});
