import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

describe('custom_006_pharmacy_rich_menu_auto_create.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, ?, ?)`)
      .run('account-a', 'channel-a', 'A', 'token-a', 'secret-a');
  });

  it('adds generator metadata without storing patient data', () => {
    const columns = db.prepare('PRAGMA table_info(rich_menu_groups)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'generator_key',
      'generator_version',
    ]));
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'line_user_id',
      'patient_id',
      'prescription_json',
    ]));
  });

  it('enforces one generated profile per account while allowing another account', () => {
    const insert = db.prepare(`INSERT INTO rich_menu_groups
      (id, account_id, name, chat_bar_text, size, generator_key, generator_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run('group-a', 'account-a', 'A', 'メニュー', 'compact', 'initial-compact-3x1', '1');
    expect(() => insert.run('group-b', 'account-a', 'B', 'メニュー', 'compact', 'initial-compact-3x1', '1'))
      .toThrow(/UNIQUE constraint failed/i);

    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
      VALUES (?, ?, ?, ?, ?)`)
      .run('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
    expect(() => insert.run('group-c', 'account-b', 'C', 'メニュー', 'compact', 'initial-compact-3x1', '1'))
      .not.toThrow();
  });
});
