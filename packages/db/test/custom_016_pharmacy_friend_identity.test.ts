import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', 'custom_016_pharmacy_friend_identity.sql');

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      line_account_id TEXT REFERENCES line_accounts(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_friends_id_line_account ON friends(id, line_account_id);
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE
    );
    INSERT INTO line_accounts VALUES ('account-a'), ('account-b');
    INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, created_at, updated_at)
    VALUES
      ('friend-a', 'U-a', 'Patient A', 'account-a', '2026-08-18', '2026-08-18'),
      ('friend-legacy', 'U-legacy', 'Legacy', NULL, '2026-08-18', '2026-08-18');
    INSERT INTO chats VALUES ('chat-a', 'friend-a'), ('chat-legacy', 'friend-legacy');
  `);
  return db;
}

describe('custom_016_pharmacy_friend_identity.sql', () => {
  it('backfills provider IDs without changing friend or child identities', () => {
    const db = legacyDatabase();
    db.exec(readFileSync(MIGRATION, 'utf8'));

    expect(db.prepare(`SELECT id, provider_line_user_id FROM friends ORDER BY id`).all())
      .toEqual([
        { id: 'friend-a', provider_line_user_id: 'U-a' },
        { id: 'friend-legacy', provider_line_user_id: 'U-legacy' },
      ]);
    expect(db.prepare(`SELECT id, friend_id FROM chats ORDER BY id`).all()).toEqual([
      { id: 'chat-a', friend_id: 'friend-a' },
      { id: 'chat-legacy', friend_id: 'friend-legacy' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('allows the same provider user in different accounts but not twice in one account', () => {
    const db = legacyDatabase();
    db.exec(readFileSync(MIGRATION, 'utf8'));
    const insert = db.prepare(`INSERT INTO friends
      (id, line_user_id, provider_line_user_id, line_account_id, created_at, updated_at)
      VALUES (?, ?, 'U-shared', ?, '2026-08-18', '2026-08-18')`);

    expect(() => insert.run('friend-shared-a', 'friend-key:a', 'account-a')).not.toThrow();
    expect(() => insert.run('friend-shared-b', 'friend-key:b', 'account-b')).not.toThrow();
    expect(() => insert.run('friend-shared-a2', 'friend-key:a2', 'account-a'))
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('keeps old writers compatible and rejects identity erasure or account reassignment', () => {
    const db = legacyDatabase();
    db.exec(readFileSync(MIGRATION, 'utf8'));
    db.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, created_at, updated_at)
      VALUES ('friend-old-writer', 'U-old-writer', 'account-a', '2026-08-18', '2026-08-18')`).run();

    expect(db.prepare(`SELECT provider_line_user_id FROM friends
      WHERE id = 'friend-old-writer'`).get()).toEqual({ provider_line_user_id: 'U-old-writer' });
    expect(() => db.prepare(`UPDATE friends SET provider_line_user_id = NULL
      WHERE id = 'friend-a'`).run()).toThrow(/FRIEND_PROVIDER_LINE_USER_ID_REQUIRED/);
    expect(() => db.prepare(`UPDATE friends SET line_account_id = 'account-b'
      WHERE id = 'friend-a'`).run()).toThrow(/FRIEND_ACCOUNT_IMMUTABLE/);
  });
});
