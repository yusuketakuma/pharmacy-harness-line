import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  acquirePublishLock,
  acquireRichMenuAccountLock,
  markRichMenuGroupPublished,
  markRichMenuGroupUnpublished,
  releasePublishLock,
} from '../src/rich-menus.js';

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>),
    )(),
  } as unknown as D1Database;
}

describe('rich-menu publish state', () => {
  it('reclaims a publish lock left by an interrupted worker', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE rich_menu_groups (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        publishing_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO rich_menu_groups VALUES ('group-a', 'draft', '2000-01-01T00:00:00.000Z', 'old');
    `);

    const token = await acquirePublishLock(d1From(sqlite), 'group-a');
    expect(token).toEqual(expect.any(String));
    expect(sqlite.prepare(
      `SELECT publishing_at FROM rich_menu_groups WHERE id = 'group-a'`,
    ).get()).not.toEqual({ publishing_at: '2000-01-01T00:00:00.000Z' });
  });

  it('does not steal an active publish lock', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE rich_menu_groups (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        publishing_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO rich_menu_groups VALUES ('group-a', 'draft', '2999-01-01T00:00:00.000Z', 'old');
    `);

    await expect(acquirePublishLock(d1From(sqlite), 'group-a')).resolves.toBeNull();
    expect(sqlite.prepare(
      `SELECT publishing_at FROM rich_menu_groups WHERE id = 'group-a'`,
    ).get()).toEqual({ publishing_at: '2999-01-01T00:00:00.000Z' });
  });

  it('serializes account-wide rich-menu operations across groups', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE rich_menu_groups (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
        publishing_at TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO rich_menu_groups VALUES ('group-a', 'account-a', 'published', NULL, 'old');
      INSERT INTO rich_menu_groups VALUES ('group-b', 'account-a', 'published', NULL, 'old');
      INSERT INTO rich_menu_groups VALUES ('group-c', 'account-b', 'published', NULL, 'old');
    `);
    const db = d1From(sqlite);

    const first = await acquireRichMenuAccountLock(db, 'account-a');
    expect(first).toMatchObject({ groupId: 'group-a', token: expect.any(String) });
    await expect(acquireRichMenuAccountLock(db, 'account-a')).resolves.toBeNull();
    await expect(acquireRichMenuAccountLock(db, 'account-b')).resolves.toMatchObject({
      groupId: 'group-c', token: expect.any(String),
    });
  });

  it('commits all page IDs and the group status in one D1 batch', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE rich_menu_groups (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        publishing_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE rich_menu_pages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        alias_id TEXT NOT NULL,
        line_richmenu_id TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO rich_menu_groups VALUES ('group-a', 'draft', 'locked', 'old');
      INSERT INTO rich_menu_pages VALUES ('page-a', 'group-a', 'alias-old-a', 'line-old-a', 'old');
      INSERT INTO rich_menu_pages VALUES ('page-b', 'group-a', 'alias-old-b', 'line-old-b', 'old');
    `);

    await markRichMenuGroupPublished(d1From(sqlite), 'group-a', 'group-a', 'locked', [
      { pageId: 'page-a', aliasId: 'alias-new-a', lineRichMenuId: 'line-new-a' },
      { pageId: 'page-b', aliasId: 'alias-new-b', lineRichMenuId: 'line-new-b' },
    ]);

    expect(sqlite.prepare(
      `SELECT id, alias_id, line_richmenu_id FROM rich_menu_pages ORDER BY id`,
    ).all()).toEqual([
      { id: 'page-a', alias_id: 'alias-new-a', line_richmenu_id: 'line-new-a' },
      { id: 'page-b', alias_id: 'alias-new-b', line_richmenu_id: 'line-new-b' },
    ]);
    expect(sqlite.prepare(
      `SELECT status, publishing_at FROM rich_menu_groups WHERE id = 'group-a'`,
    ).get()).toEqual({ status: 'published', publishing_at: 'locked' });
    await releasePublishLock(d1From(sqlite), 'group-a', 'locked');
    expect(sqlite.prepare(
      `SELECT publishing_at FROM rich_menu_groups WHERE id = 'group-a'`,
    ).get()).toEqual({ publishing_at: null });
  });

  it('does not let a stale worker release or publish over a replacement lock', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE rich_menu_groups (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, publishing_at TEXT,
        is_default_for_all INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE rich_menu_pages (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, alias_id TEXT NOT NULL,
        line_richmenu_id TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO rich_menu_groups VALUES ('group-a', 'draft', 'replacement-token', 0, 'old');
      INSERT INTO rich_menu_pages VALUES ('page-a', 'group-a', 'alias-old', 'line-old', 'old');
    `);
    const db = d1From(sqlite);

    await releasePublishLock(db, 'group-a', 'stale-token');
    await expect(markRichMenuGroupPublished(db, 'group-a', 'group-a', 'stale-token', [{
      pageId: 'page-a', aliasId: 'alias-new', lineRichMenuId: 'line-new',
    }])).rejects.toThrow('publish lock lost');
    await expect(markRichMenuGroupUnpublished(
      db, 'group-a', 'group-a', 'stale-token',
    )).rejects.toThrow('publish lock lost');

    expect(sqlite.prepare(
      `SELECT status, publishing_at FROM rich_menu_groups WHERE id = 'group-a'`,
    ).get()).toEqual({ status: 'draft', publishing_at: 'replacement-token' });
    expect(sqlite.prepare(
      `SELECT alias_id, line_richmenu_id FROM rich_menu_pages WHERE id = 'page-a'`,
    ).get()).toEqual({ alias_id: 'alias-old', line_richmenu_id: 'line-old' });
  });
});
