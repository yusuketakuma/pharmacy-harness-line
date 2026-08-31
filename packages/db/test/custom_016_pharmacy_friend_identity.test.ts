import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  db.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES
      ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
      ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
    INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, created_at, updated_at)
    VALUES
      ('friend-a', 'U-a', 'Patient A', 'account-a', '2026-08-18', '2026-08-18'),
      ('friend-legacy', 'U-legacy', 'Legacy', NULL, '2026-08-18', '2026-08-18');
    INSERT INTO chats (id, friend_id)
    VALUES ('chat-a', 'friend-a'), ('chat-legacy', 'friend-legacy');
  `);
  return db;
}

describe('custom_016_pharmacy_friend_identity.sql', () => {
  it('stores provider IDs without changing friend or child identities', () => {
    const db = database();

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
    const db = database();
    const insert = db.prepare(`INSERT INTO friends
      (id, line_user_id, provider_line_user_id, line_account_id, created_at, updated_at)
      VALUES (?, ?, 'U-shared', ?, '2026-08-18', '2026-08-18')`);

    expect(() => insert.run('friend-shared-a', 'friend-key:a', 'account-a')).not.toThrow();
    expect(() => insert.run('friend-shared-b', 'friend-key:b', 'account-b')).not.toThrow();
    expect(() => insert.run('friend-shared-a2', 'friend-key:a2', 'account-a'))
      .toThrow(/UNIQUE constraint failed/i);
  });

  it('keeps old writers compatible and rejects identity erasure or account reassignment', () => {
    const db = database();
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
