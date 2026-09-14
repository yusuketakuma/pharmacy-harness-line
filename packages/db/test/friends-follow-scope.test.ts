import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFriendByLineUserIdForAccount,
  updateFriendFollowStatus,
} from '../src/friends.js';
import { getFriendsByTag } from '../src/tags.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('friend follow status account scope', () => {
  it('keeps an account-qualified webhook update inside that account', async () => {
    let sql = '';
    let values: unknown[] = [];
    const db = {
      prepare(statement: string) {
        sql = statement;
        return { bind(...bound: unknown[]) { values = bound; return { run: async () => ({ meta: { changes: 1 } }) }; } };
      },
    } as unknown as D1Database;

    await updateFriendFollowStatus(db, 'U-patient', false, 'account-a');

    expect(sql).toContain('provider_line_user_id = ? AND line_account_id = ?');
    expect(sql).not.toContain('? IS NULL OR');
    expect(values.slice(-2)).toEqual(['U-patient', 'account-a']);
  });

  it('does not fall back to a friend owned by another account', async () => {
    const statements: string[] = [];
    const db = {
      prepare(statement: string) {
        statements.push(statement);
        return {
          bind() {
            return { first: async () => null };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      getFriendByLineUserIdForAccount(db, 'U-patient', 'account-a'),
    ).resolves.toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('provider_line_user_id = ? AND line_account_id = ?');
  });

  it('scopes tag recipients when an account is selected', async () => {
    let sql = '';
    let values: unknown[] = [];
    const db = {
      prepare(statement: string) {
        sql = statement;
        return {
          bind(...bound: unknown[]) {
            values = bound;
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    } as unknown as D1Database;

    await getFriendsByTag(db, 'tag-a', 'account-a');

    expect(sql).toContain('f.line_account_id = ?');
    expect(values).toEqual(['tag-a', 'account-a']);
  });

  it('ignores an older follow event delivered after a newer unfollow event', async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', '2026-09-14', '2026-09-14')`).run();
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, provider_line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-a', 'friend-key-a', 'U-a', 'account-a', 1, '2026-09-14', '2026-09-14')`).run();
    const db = {
      prepare(statement: string) {
        return {
          bind(...bound: unknown[]) {
            return {
              run: async () => {
                const result = sqlite.prepare(statement).run(...bound);
                return { meta: { changes: result.changes } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await updateFriendFollowStatus(db, 'U-a', false, 'account-a', {
      occurredAt: '2026-09-14T00:00:02.000Z',
      eventId: 'unfollow-event',
    });
    await updateFriendFollowStatus(db, 'U-a', true, 'account-a', {
      occurredAt: '2026-09-14T00:00:01.000Z',
      eventId: 'follow-event-old',
    });

    expect(sqlite.prepare(`SELECT is_following, unfollow_count FROM friends WHERE id = 'friend-a'`).get())
      .toEqual({ is_following: 0, unfollow_count: 1 });

    sqlite.close();
  });
});
