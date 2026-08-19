import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// This exercises the shipped schema (bootstrap.sql = schema.sql + every
// migration, see scripts/generate-bootstrap.mjs), not an isolated migration
// file. The `line_accounts_default_pharmacy_capability` trigger (added by
// custom_017_pharmacy_account_defaults.sql) is what makes "every line_account
// has a pharmacy_account_capabilities row" a DB-enforced invariant rather
// than something true only by convention. apps/worker/src/middleware/
// tenant-boundary.ts's accountResourceOwnedByStaff() has to treat a missing
// capability row as ambiguous (pre-migration legacy vs. corruption); this
// test protects the trigger that keeps that ambiguity from ever recurring
// for newly created accounts.
describe('pharmacy_account_capabilities invariant', () => {
  it('auto-creates exactly one capability row for every newly inserted line_account', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));

    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('new-account', 'channel-new', 'New Account', 'token', 'secret')`).run();

    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_account_capabilities
      WHERE line_account_id = 'new-account'`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT mode FROM pharmacy_account_capabilities
      WHERE line_account_id = 'new-account'`).get()).toEqual({ mode: 'pharmacy' });
  });

  it('does not duplicate the capability row if one is explicitly inserted first', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));

    // A provisioning path that inserts both rows in one transaction must not
    // conflict with the trigger's own INSERT OR IGNORE.
    db.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('explicit-account', 'channel-explicit', 'Explicit', 'token', 'secret');
      INSERT OR IGNORE INTO pharmacy_account_capabilities
        (line_account_id, mode, capabilities_json, proactive_monthly_limit,
         unfollow_alert_state, created_at, updated_at)
        VALUES ('explicit-account', 'pharmacy', '[]', 1, 'alert_only',
                '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
    `);

    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_account_capabilities
      WHERE line_account_id = 'explicit-account'`).get()).toEqual({ count: 1 });
  });
});
