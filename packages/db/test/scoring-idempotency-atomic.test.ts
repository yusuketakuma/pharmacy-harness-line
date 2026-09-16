import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addScore, getFriendScore } from '../src/scoring.js';
import { recordLinkClick, createTrackedLink, getTrackedLinkById } from '../src/tracked-links.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  const statement = (sql: string) => {
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        values = args;
        return this;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...(values as never[]));
        return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
      },
      first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) as T) ?? null,
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(values as never[])) as T[],
        success: true,
        meta: {},
      }),
    } as unknown as D1PreparedStatement;
  };
  db = {
    prepare: (sql: string) => statement(sql),
    // Emulate D1 batch atomicity with a real transaction; sequential execution
    // lets later statements observe earlier ones.
    batch: async (statements: D1PreparedStatement[]) => {
      const tasks = sqlite.transaction(() => statements.map((prepared) => prepared.run()))();
      return Promise.all(tasks) as never;
    },
  } as unknown as D1Database;
  sqlite
    .prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a','channel-a','A','token','secret')`)
    .run();
  sqlite
    .prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
      VALUES ('friend-a','lu-a','pu-a','account-a')`)
    .run();
});

describe('addScore ledger/cache atomicity', () => {
  it('keeps friends.score in sync with the ledger and dedupes keyed retries', async () => {
    expect(await addScore(db, {
      friendId: 'friend-a', scoreChange: 10, reason: 'first', idempotencyKey: 'evt-1',
    })).toBe(true);
    expect(await getFriendScore(db, 'friend-a')).toBe(10);

    // Keyed retry: ledger insert is ignored and the score must not move.
    expect(await addScore(db, {
      friendId: 'friend-a', scoreChange: 10, reason: 'retry', idempotencyKey: 'evt-1',
    })).toBe(false);
    expect(await getFriendScore(db, 'friend-a')).toBe(10);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM friend_scores`).get() as { c: number }).c,
    ).toBe(1);

    // Unkeyed callers keep the historical always-apply behavior.
    expect(await addScore(db, { friendId: 'friend-a', scoreChange: 3, reason: 'unkeyed' })).toBe(true);
    expect(await getFriendScore(db, 'friend-a')).toBe(13);
  });
});

describe('recordLinkClick', () => {
  it('keeps click_count consistent with link_clicks rows', async () => {
    const link = await createTrackedLink(db, {
      name: 'campaign', originalUrl: 'https://example.com/lp',
    });
    await recordLinkClick(db, link.id, 'friend-a');
    await recordLinkClick(db, link.id, null);
    const stored = await getTrackedLinkById(db, link.id);
    expect(stored!.click_count).toBe(2);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM link_clicks WHERE tracked_link_id = ?`)
        .get(link.id) as { c: number }).c,
    ).toBe(2);
  });
});
