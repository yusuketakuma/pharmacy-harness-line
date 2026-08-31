import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbMocks = vi.hoisted(() => ({
  getBroadcasts: vi.fn(),
  getQueuedBroadcasts: vi.fn(),
  getFriendsByTag: vi.fn(),
  getLineAccountById: vi.fn(),
  updateBroadcastLineRequestId: vi.fn(),
  createBroadcastInsight: vi.fn(),
  updateBroadcastStatus: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@line-crm/db')>()),
  ...dbMocks,
}));

const lineSdk = vi.hoisted(() => ({
  pushMessage: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessage = lineSdk.pushMessage;
    broadcast = lineSdk.broadcast;
  },
}));

const pharmacyMode = vi.hoisted(() => vi.fn());
vi.mock('../custom/pharmacy/growth-loop/access.js', () => ({
  isPharmacyModeAccount: pharmacyMode,
}));

const getActiveMappedAccountTenantId = vi.hoisted(() => vi.fn());
vi.mock('./step-delivery.js', () => ({ getActiveMappedAccountTenantId }));

const deliverTrackedLinePush = vi.hoisted(() => vi.fn());
const deliverTrackedLineBroadcast = vi.hoisted(() => vi.fn());
vi.mock('./outbound-line-delivery.js', () => ({
  deliverTrackedLineBroadcast,
  deliverTrackedLinePush,
}));

import { processQueuedBroadcasts } from './broadcast.js';

const broadcast = {
  id: 'broadcast-a',
  title: 'Personalized',
  message_type: 'text',
  message_content: '{{name}}さん',
  target_type: 'tag',
  target_tag_id: 'tag-a',
  status: 'sending',
  scheduled_at: null,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-08-30T00:00:00.000Z',
  line_account_id: 'account-a',
  account_ids: null,
  batch_offset: 0,
  batch_lock_at: null,
  segment_conditions: null,
  track_links: 0,
  alt_text: null,
};

function database() {
  const sql: string[] = [];
  const db = {
    prepare(statementSql: string) {
      sql.push(statementSql);
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () => statementSql.includes('FROM tenant_line_accounts')
          ? { ok: 1 }
          : null,
        all: async () => ({
          results: statementSql.includes('FROM friends')
            ? [{ id: 'friend-a', line_user_id: 'U-a', display_name: 'Alice' }]
            : [],
        }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, sql };
}

function statefulDatabase(state: {
  broadcast: typeof broadcast;
  logged: Set<string>;
  retired?: Set<string>;
  retiredTest?: Set<string>;
  failedAccountIds: string | null;
}) {
  const sql: string[] = [];
  const db = {
    prepare(statementSql: string) {
      sql.push(statementSql);
      let values: unknown[] = [];
      const statement = {
        bind: (...next: unknown[]) => {
          values = next;
          return statement;
        },
        first: async () => {
          if (statementSql.includes('FROM tenant_line_accounts')) return { ok: 1 };
          if (statementSql.includes('FROM messages_log')) {
            return state.logged.has(String(values[1])) ? { ok: 1 } : null;
          }
          return null;
        },
        all: async () => ({
          results: statementSql.includes('FROM messages_log')
            ? [...state.logged].map((friend_id) => ({ friend_id }))
            : statementSql.includes('FROM outbound_line_deliveries')
              ? [...(state.retired ?? [])]
                .filter((friend_id) => !statementSql.includes("payload.log_delivery_type != 'test'")
                  || !(state.retiredTest ?? new Set()).has(friend_id))
                .map((friend_id) => ({ friend_id }))
            : [],
        }),
        run: async () => {
          if (statementSql.includes('SET batch_offset = -1')) {
            state.broadcast.batch_offset = -1;
          }
          if (statementSql.includes('SET batch_offset = 0')) {
            state.broadcast.batch_offset = 0;
          }
          if (statementSql.includes('SET batch_offset = ?')) {
            state.broadcast.batch_offset = Number(values[0]);
          }
          if (statementSql.includes('SET total_count = ?')) {
            state.broadcast.total_count = Number(values[0]);
          }
          if (statementSql.includes('success_count = (')) {
            state.broadcast.success_count = state.logged.size;
          }
          if (statementSql.includes('failed_account_ids = ?')) {
            state.failedAccountIds = values[1] as string | null;
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, sql };
}

describe('queued personalized broadcast delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getBroadcasts.mockResolvedValue([]);
    dbMocks.getQueuedBroadcasts.mockResolvedValue([broadcast]);
    dbMocks.getFriendsByTag.mockResolvedValue([{
      id: 'friend-a',
      line_user_id: 'U-a',
      display_name: 'Alice',
      is_following: 1,
    }]);
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-a',
      channel_access_token: 'token-a',
      is_active: 1,
      liff_id: null,
    });
    dbMocks.updateBroadcastLineRequestId.mockResolvedValue(undefined);
    dbMocks.createBroadcastInsight.mockResolvedValue(undefined);
    dbMocks.updateBroadcastStatus.mockResolvedValue(undefined);
    pharmacyMode.mockResolvedValue(false);
    getActiveMappedAccountTenantId.mockResolvedValue('tenant-a');
    lineSdk.pushMessage.mockResolvedValue({});
    lineSdk.broadcast.mockResolvedValue({ requestId: 'request-a' });
    deliverTrackedLineBroadcast.mockImplementation(async (params) => {
      await params.send(params.request, params.operationId);
      return 'sent';
    });
    deliverTrackedLinePush.mockImplementation(async (params) => {
      await params.send(params.request, params.operationId);
      return 'sent';
    });
  });

  it('settles each recipient through the scoped ledger without a raw duplicate log', async () => {
    const { db, sql } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      broadcastId: 'broadcast-a',
      source: 'broadcast',
    }));
    expect(lineSdk.pushMessage).toHaveBeenCalledOnce();
    expect(sql.filter((statement) => statement.includes('INSERT INTO messages_log'))).toEqual([]);
  });

  it('keeps the recipient operation stable when the display name changes', async () => {
    const { db } = database();

    await processQueuedBroadcasts(db, {} as never);
    dbMocks.getFriendsByTag.mockResolvedValue([{
      id: 'friend-a',
      line_user_id: 'U-a',
      display_name: 'Bob',
      is_following: 1,
    }]);
    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledTimes(2);
    expect(deliverTrackedLinePush.mock.calls[1]?.[0].operationId)
      .toBe(deliverTrackedLinePush.mock.calls[0]?.[0].operationId);
  });

  it('does not skip an unsent recipient when the live audience shrinks', async () => {
    const state = {
      broadcast: { ...broadcast },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    let friends = Array.from({ length: 11 }, (_, index) => ({
      id: `friend-${index}`,
      line_user_id: `U-${index}`,
      display_name: `Friend ${index}`,
      is_following: 1,
    }));
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    dbMocks.getFriendsByTag.mockImplementation(async () => friends);
    deliverTrackedLinePush.mockImplementation(async (params) => {
      await params.send(params.request, params.operationId);
      state.logged.add(params.friendId);
      return 'sent';
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);
    expect(state.logged.size).toBe(10);
    friends = friends.slice(1);
    await processQueuedBroadcasts(db, {} as never);

    expect(state.logged.has('friend-10')).toBe(true);
  });

  it('continues after a terminal recipient and records account reconciliation', async () => {
    const state = {
      broadcast: { ...broadcast },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    dbMocks.getFriendsByTag.mockResolvedValue([
      { id: 'friend-a', line_user_id: 'U-a', display_name: 'A', is_following: 1 },
      { id: 'friend-b', line_user_id: 'U-b', display_name: 'B', is_following: 1 },
    ]);
    deliverTrackedLinePush.mockImplementation(async (params) => {
      if (params.friendId === 'friend-a') return 'reconciliation_required';
      state.logged.add(params.friendId);
      return 'sent';
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush.mock.calls.map(([params]) => params.friendId))
      .toEqual(['friend-a', 'friend-b']);
    expect(state.failedAccountIds).toBe(JSON.stringify(['account-a']));
    expect(dbMocks.updateBroadcastStatus).not.toHaveBeenCalledWith(
      db,
      'broadcast-a',
      'sent',
    );
  });

  it('does not let retired recipients consume the next provider batch', async () => {
    const retired = new Set(Array.from({ length: 10 }, (_, index) => `friend-${index}`));
    const state = {
      broadcast: { ...broadcast },
      logged: new Set<string>(),
      retired,
      failedAccountIds: null as string | null,
    };
    const friends = Array.from({ length: 11 }, (_, index) => ({
      id: `friend-${index}`,
      line_user_id: `U-${index}`,
      display_name: `Friend ${index}`,
      is_following: 1,
    }));
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    dbMocks.getFriendsByTag.mockResolvedValue(friends);
    deliverTrackedLinePush.mockImplementation(async (params) => {
      state.logged.add(params.friendId);
      return 'sent';
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush.mock.calls.map(([params]) => params.friendId))
      .toEqual(['friend-10']);
    expect(state.failedAccountIds).toBe(JSON.stringify(['account-a']));
  });

  it('does not let a retired test send suppress the real broadcast', async () => {
    const state = {
      broadcast: { ...broadcast },
      logged: new Set<string>(),
      retired: new Set(['friend-a']),
      retiredTest: new Set(['friend-a']),
      failedAccountIds: null as string | null,
    };
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    deliverTrackedLinePush.mockImplementation(async (params) => {
      state.logged.add(params.friendId);
      return 'sent';
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      friendId: 'friend-a',
      source: 'broadcast',
    }));
    expect(state.broadcast.success_count).toBe(1);
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(db, 'broadcast-a', 'sent');
  });

  it('advances an already accepted recipient without calling LINE again', async () => {
    deliverTrackedLinePush.mockResolvedValue('already_sent');
    const { db } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledOnce();
    expect(lineSdk.pushMessage).not.toHaveBeenCalled();
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(
      db,
      'broadcast-a',
      'sent',
    );
  });

  it('releases the queue lock without LINE when tenant mapping disappears', async () => {
    getActiveMappedAccountTenantId.mockResolvedValue(null);
    const { db, sql } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).not.toHaveBeenCalled();
    expect(lineSdk.pushMessage).not.toHaveBeenCalled();
    expect(sql.some((statement) => statement.includes('SET batch_offset = ?'))).toBe(true);
  });

  it('uses the scoped recipient ledger for a non-personalized tag broadcast', async () => {
    dbMocks.getQueuedBroadcasts.mockResolvedValue([{
      ...broadcast,
      message_content: 'same message',
    }]);
    const { db } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      content: 'same message',
      source: 'broadcast',
    }));
    expect(lineSdk.pushMessage).toHaveBeenCalledOnce();
  });

  it('preserves the provider audience for a queued non-personalized all broadcast', async () => {
    dbMocks.getQueuedBroadcasts.mockResolvedValue([]);
    dbMocks.getBroadcasts.mockResolvedValue([{
      ...broadcast,
      message_content: 'same message',
      target_type: 'all',
      target_tag_id: null,
    }]);
    const { db, sql } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(sql.some((statement) => statement.includes('FROM friends'))).toBe(false);
    expect(deliverTrackedLineBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      request: { messages: [{ type: 'text', text: 'same message' }] },
    }));
    expect(lineSdk.broadcast).toHaveBeenCalledOnce();
    expect(deliverTrackedLinePush).not.toHaveBeenCalled();
  });

  it('does not use the provider-wide path for legacy all broadcasts with conditions', async () => {
    dbMocks.getQueuedBroadcasts.mockResolvedValue([{
      ...broadcast,
      message_content: 'same message',
      target_type: 'all',
      target_tag_id: null,
      segment_conditions: JSON.stringify({
        operator: 'AND',
        rules: [{ type: 'is_following', value: true }],
      }),
    }]);
    const { db } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      friendId: 'friend-a',
      source: 'broadcast',
    }));
    expect(deliverTrackedLineBroadcast).not.toHaveBeenCalled();
    expect(lineSdk.broadcast).not.toHaveBeenCalled();
  });

  it('exposes a nonnegative terminal offset for a provider-wide broadcast', async () => {
    const state = {
      broadcast: { ...broadcast, target_type: 'all' as const, message_content: 'same message' },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);

    expect(state.broadcast.batch_offset).toBe(0);
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(
      db,
      'broadcast-a',
      'sent',
      { totalCount: 0, successCount: 0 },
    );
  });

  it('keeps the provider request id across settlement retry completion', async () => {
    const state = {
      broadcast: { ...broadcast, target_type: 'all' as const, message_content: 'same message' },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    deliverTrackedLineBroadcast
      .mockImplementationOnce(async (params) => {
        await params.send(params.request, params.operationId);
        throw new Error('OUTBOUND_LINE_SETTLEMENT_FAILED');
      })
      .mockResolvedValueOnce('already_sent');
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);
    await processQueuedBroadcasts(db, {} as never);

    expect(lineSdk.broadcast).toHaveBeenCalledOnce();
    expect(dbMocks.updateBroadcastLineRequestId).toHaveBeenCalledOnce();
    expect(dbMocks.updateBroadcastLineRequestId).toHaveBeenCalledWith(
      db,
      'broadcast-a',
      'request-a',
      null,
    );
    expect(dbMocks.createBroadcastInsight).toHaveBeenCalledOnce();
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(
      db,
      'broadcast-a',
      'sent',
      { totalCount: 0, successCount: 0 },
    );
    expect(state.broadcast.batch_offset).toBe(0);
  });

  it.each([null, ''])('does not overwrite an existing request id with %j', async (requestId) => {
    const state = {
      broadcast: { ...broadcast, target_type: 'all' as const, message_content: 'same message' },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    let storedRequestId: string | null = 'existing-request';
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    lineSdk.broadcast.mockResolvedValue({ requestId });
    dbMocks.updateBroadcastLineRequestId.mockImplementation(async (_db, _id, nextRequestId) => {
      storedRequestId = nextRequestId as string | null;
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);

    expect(storedRequestId).toBe('existing-request');
    expect(dbMocks.updateBroadcastLineRequestId).not.toHaveBeenCalled();
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(
      db,
      'broadcast-a',
      'sent',
      { totalCount: 0, successCount: 0 },
    );
  });

  it('expands the denominator when the live audience grows between batches', async () => {
    const state = {
      broadcast: { ...broadcast },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    let friends = Array.from({ length: 11 }, (_, index) => ({
      id: `friend-${index}`,
      line_user_id: `U-${index}`,
      display_name: `Friend ${index}`,
      is_following: 1,
    }));
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    dbMocks.getFriendsByTag.mockImplementation(async () => friends);
    deliverTrackedLinePush.mockImplementation(async (params) => {
      await params.send(params.request, params.operationId);
      state.logged.add(params.friendId);
      return 'sent';
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);
    expect(state.broadcast).toMatchObject({ total_count: 11, success_count: 10 });
    friends = [...friends, {
      id: 'friend-11',
      line_user_id: 'U-11',
      display_name: 'Friend 11',
      is_following: 1,
    }];
    await processQueuedBroadcasts(db, {} as never);

    expect(state.broadcast).toMatchObject({ total_count: 12, success_count: 12 });
    expect(state.broadcast.success_count).toBeLessThanOrEqual(state.broadcast.total_count);
  });

  it('removes an unsent recipient from the denominator when the live audience shrinks', async () => {
    const state = {
      broadcast: { ...broadcast },
      logged: new Set<string>(),
      failedAccountIds: null as string | null,
    };
    let friends = Array.from({ length: 11 }, (_, index) => ({
      id: `friend-${index}`,
      line_user_id: `U-${index}`,
      display_name: `Friend ${index}`,
      is_following: 1,
    }));
    dbMocks.getQueuedBroadcasts.mockImplementation(async () => [state.broadcast]);
    dbMocks.getFriendsByTag.mockImplementation(async () => friends);
    deliverTrackedLinePush.mockImplementation(async (params) => {
      await params.send(params.request, params.operationId);
      state.logged.add(params.friendId);
      return 'sent';
    });
    const { db } = statefulDatabase(state);

    await processQueuedBroadcasts(db, {} as never);
    expect(state.broadcast).toMatchObject({ total_count: 11, success_count: 10 });
    friends = friends.slice(0, 10);
    await processQueuedBroadcasts(db, {} as never);

    expect(state.broadcast).toMatchObject({ total_count: 10, success_count: 10 });
    expect(state.broadcast.success_count).toBeLessThanOrEqual(state.broadcast.total_count);
    expect(dbMocks.updateBroadcastStatus).toHaveBeenCalledWith(db, 'broadcast-a', 'sent');
  });

  it('delivers a queued segment broadcast per recipient', async () => {
    dbMocks.getQueuedBroadcasts.mockResolvedValue([{
      ...broadcast,
      target_type: 'segment' as never,
      message_content: 'same message',
      segment_conditions: JSON.stringify({
        operator: 'AND',
        rules: [{ type: 'is_following', value: true }],
      }),
    }]);
    const { db } = database();

    await processQueuedBroadcasts(db, {} as never);

    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      friendId: 'friend-a',
      source: 'broadcast',
    }));
    expect(deliverTrackedLineBroadcast).not.toHaveBeenCalled();
    expect(lineSdk.broadcast).not.toHaveBeenCalled();
  });

  it('contains no raw LINE multicast delivery path', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'broadcast.ts'), 'utf8');

    expect(source).not.toContain('lineClient.multicast(');
  });
});
