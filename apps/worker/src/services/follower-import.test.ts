import { describe, expect, test, vi } from 'vitest';
import {
  detectFollowerImportCapability,
  getFollowerImportState,
  processFollowerImportStep,
  startFollowerImport,
} from './follower-import.js';

const uid = (hex: string) => `U${hex.repeat(32)}`;

type StoredFriend = {
  id: string;
  line_user_id: string;
  provider_line_user_id?: string;
  line_account_id: string | null;
  is_following: number;
  display_name: string | null;
  picture_url: string | null;
  status_message: string | null;
};

function makeDb(initialFriends: StoredFriend[] = []) {
  let setting: string | null = null;
  const friends = new Map(initialFriends.map((f) => [f.id, {
    ...f,
    provider_line_user_id: f.provider_line_user_id ?? f.line_user_id,
  }]));

  const execute = (sql: string, args: unknown[]) => {
    if (sql.includes('INSERT INTO account_settings')) {
      setting = args[3] as string;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE account_settings')) {
      if (setting !== args[4]) return { meta: { changes: 0 } };
      setting = args[0] as string;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('INSERT INTO friends')) {
      const [id, physicalLineUserId, providerLineUserId, accountId] = args as [string, string, string, string];
      const existing = [...friends.values()].find((row) =>
        row.provider_line_user_id === providerLineUserId && row.line_account_id === accountId);
      if (!existing) {
        friends.set(id, {
          id,
          line_user_id: physicalLineUserId,
          provider_line_user_id: providerLineUserId,
          line_account_id: accountId,
          is_following: 1,
          display_name: null,
          picture_url: null,
          status_message: null,
        });
      } else {
        existing.is_following = 1;
      }
      return { meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE friends') && sql.includes('display_name')) {
      const [displayName, pictureUrl, statusMessage, , id] = args;
      const row = [...friends.values()].find((f) => f.id === id);
      if (row) {
        row.display_name = displayName as string | null;
        row.picture_url = pictureUrl as string | null;
        row.status_message = statusMessage as string | null;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  };

  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql,
        args,
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('SELECT value FROM account_settings')) {
            return setting === null ? null : { value: setting };
          }
          throw new Error(`Unhandled first SQL: ${sql}`);
        }),
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('WHERE provider_line_user_id IN')) {
            const accountId = args.at(-1) as string;
            const requested = new Set(args.slice(0, -1) as string[]);
            return { results: [...friends.values()]
              .filter((f) => f.line_account_id === accountId && requested.has(f.provider_line_user_id!))
              .map((f) => ({ ...f, line_user_id: f.provider_line_user_id })) };
          }
          if (sql.includes('AND display_name IS NULL')) {
            const [accountId, afterId, limit] = args as [string, string, number];
            return {
              results: [...friends.values()]
                .filter((f) => f.line_account_id === accountId && f.is_following === 1 &&
                  f.display_name === null && f.id > afterId)
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, limit)
                .map(({ id, provider_line_user_id }) => ({ id, line_user_id: provider_line_user_id })),
            };
          }
          throw new Error(`Unhandled all SQL: ${sql}`);
        }),
        run: vi.fn().mockImplementation(async () => execute(sql, args)),
      }),
    })),
    batch: vi.fn().mockImplementation(async (statements: Array<{ sql: string; args: unknown[] }>) =>
      statements.map((statement) => execute(statement.sql, statement.args))),
  } as unknown as D1Database;

  return {
    db,
    friends,
    getFriend: (lineUserId: string, accountId: string) => [...friends.values()].find((friend) =>
      friend.provider_line_user_id === lineUserId && friend.line_account_id === accountId),
    getSetting: () => setting,
  };
}

describe('persisted one-time follower import', () => {
  test('detects an unavailable account once and stores the result', async () => {
    const { db, getSetting } = makeDb();
    const client = {
      getFollowerIds: vi.fn().mockRejectedValue(new Error('LINE API error: 403 Forbidden')),
    };

    const state = await detectFollowerImportCapability(db, client, 'acc-1');

    expect(client.getFollowerIds).toHaveBeenCalledWith(1);
    expect(state.capability).toBe('unavailable');
    expect(JSON.parse(getSetting()!).capability).toBe('unavailable');
  });

  test('resumes bounded steps and cannot restart after completion', async () => {
    const { db, getFriend } = makeDb();
    const lineUserId = uid('a');
    const client = {
      getFollowerIds: vi.fn()
        .mockResolvedValueOnce({ userIds: [] })
        .mockResolvedValueOnce({ userIds: [lineUserId] }),
      getProfile: vi.fn().mockResolvedValue({
        displayName: '移行患者',
        pictureUrl: 'https://example.com/profile.jpg',
      }),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    const ids = await processFollowerImportStep(db, client, 'acc-1');
    expect(ids.state.phase).toBe('hydrating_profiles');
    expect(ids.state.imported).toBe(1);

    const profiles = await processFollowerImportStep(db, client, 'acc-1');
    expect(profiles.state.phase).toBe('completed');
    expect(profiles.state.profilesUpdated).toBe(1);
    expect(getFriend(lineUserId, 'acc-1')?.display_name).toBe('移行患者');

    const completed = await startFollowerImport(db, 'acc-1');
    expect(completed.phase).toBe('completed');
    expect(client.getFollowerIds).toHaveBeenCalledTimes(2);
    expect((await getFollowerImportState(db, 'acc-1')).completedAt).not.toBeNull();
  });

  test('creates an account-local friend when the same LINE user follows another account', async () => {
    const lineUserId = uid('b');
    const { db, friends, getFriend } = makeDb([{
      id: 'friend-a',
      line_user_id: 'friend-key:a',
      provider_line_user_id: lineUserId,
      line_account_id: 'acc-a',
      is_following: 1,
      display_name: 'Account A',
      picture_url: null,
      status_message: null,
    }]);
    const client = {
      getFollowerIds: vi.fn()
        .mockResolvedValueOnce({ userIds: [] })
        .mockResolvedValueOnce({ userIds: [lineUserId] }),
      getProfile: vi.fn().mockResolvedValue({ displayName: 'Account B' }),
    };

    await detectFollowerImportCapability(db, client, 'acc-b');
    await startFollowerImport(db, 'acc-b');
    const result = await processFollowerImportStep(db, client, 'acc-b');

    expect(result.state).toMatchObject({ imported: 1, conflicts: 0, claimedUnassigned: 0 });
    expect(getFriend(lineUserId, 'acc-a')?.display_name).toBe('Account A');
    expect(getFriend(lineUserId, 'acc-b')).toMatchObject({
      line_user_id: expect.stringMatching(/^friend-key:/),
      provider_line_user_id: lineUserId,
    });
    expect(friends).toHaveLength(2);
  });
});
