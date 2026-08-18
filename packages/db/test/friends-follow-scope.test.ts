import { describe, expect, it } from 'vitest';
import {
  getFriendByLineUserIdForAccount,
  updateFriendFollowStatus,
} from '../src/friends.js';
import { getFriendsByTag } from '../src/tags.js';

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
});
