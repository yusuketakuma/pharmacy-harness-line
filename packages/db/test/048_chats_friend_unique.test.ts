import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createChat, upsertChatOnMessage, getChatByFriendId } from '../src/chats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async run() {
              stmt.run(...params);
              return { results: [], success: true, meta: {} };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
        async run() {
          sqlite.prepare(query).run();
          return { results: [], success: true, meta: {} };
        },
        async first<T>() {
          return (sqlite.prepare(query).get() as T) ?? null;
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all() as T[], success: true, meta: {} };
        },
      };
    },
  } as unknown as D1Database;
}

function insertFriend(sqlite: Database.Database, id: string): void {
  sqlite
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'Test User', '2024-01-01T00:00:00.000+09:00', '2024-01-01T00:00:00.000+09:00')`,
    )
    .run(id, `U${id.replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32)}`);
}

function insertChatRow(
  sqlite: Database.Database,
  row: {
    id: string;
    friendId: string;
    status: string;
    createdAt: string;
    updatedAt?: string;
    operatorId?: string;
    notes?: string;
    lastMessageAt?: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO chats (id, friend_id, status, operator_id, notes, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.friendId,
      row.status,
      row.operatorId ?? null,
      row.notes ?? null,
      row.lastMessageAt ?? null,
      row.createdAt,
      row.updatedAt ?? row.createdAt,
    );
}

// UNIQUE インデックス導入前の重複行がある DB を再現する
function dropUniqueIndex(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_chats_friend_unique');
}

describe('createChat / upsertChatOnMessage single-row guarantee', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
  });

  it('createChat returns the existing row instead of inserting a duplicate', async () => {
    insertFriend(sqlite, 'f-1');
    const first = await createChat(db, { friendId: 'f-1' });
    const second = await createChat(db, { friendId: 'f-1' });

    expect(second.id).toBe(first.id);
    const count = sqlite.prepare(`SELECT COUNT(*) AS c FROM chats WHERE friend_id = 'f-1'`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('upsertChatOnMessage never creates a second row for the same friend', async () => {
    insertFriend(sqlite, 'f-2');
    const a = await upsertChatOnMessage(db, 'f-2');
    const b = await upsertChatOnMessage(db, 'f-2');

    expect(b.id).toBe(a.id);
    const count = sqlite.prepare(`SELECT COUNT(*) AS c FROM chats WHERE friend_id = 'f-2'`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('upsertChatOnMessage flips resolved back to unread and refreshes last_message_at (regression)', async () => {
    insertFriend(sqlite, 'f-3');
    const chat = await upsertChatOnMessage(db, 'f-3');
    sqlite
      .prepare(`UPDATE chats SET status = 'resolved', last_message_at = '2024-01-01T00:00:00.000+09:00' WHERE id = ?`)
      .run(chat.id);

    const after = await upsertChatOnMessage(db, 'f-3');
    expect(after.id).toBe(chat.id);
    expect(after.status).toBe('unread');
    // 受信メッセージの時刻で更新される (resolveOrCreateChat とのレースで
    // resolved 行を掴んだケースでも取りこぼさないための保証)
    expect(after.last_message_at).not.toBe('2024-01-01T00:00:00.000+09:00');
  });

  it('getChatByFriendId picks the newest row when legacy duplicates remain', async () => {
    insertFriend(sqlite, 'f-4');
    dropUniqueIndex(sqlite);
    insertChatRow(sqlite, { id: 'c-old', friendId: 'f-4', status: 'resolved', createdAt: '2024-01-01T00:00:00.000+09:00' });
    insertChatRow(sqlite, { id: 'c-new', friendId: 'f-4', status: 'unread', createdAt: '2024-12-01T00:00:00.000+09:00' });

    const row = await getChatByFriendId(db, 'f-4');
    expect(row?.id).toBe('c-new');
  });
});
