import { describe, expect, it } from 'vitest';
import { updateFriendFollowStatus } from '../src/friends.js';

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

    expect(sql).toContain('(? IS NULL OR line_account_id = ?)');
    expect(values.slice(-3)).toEqual(['U-patient', 'account-a', 'account-a']);
  });
});
