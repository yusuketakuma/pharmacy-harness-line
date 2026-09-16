import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../../index.js';
import type { AuthenticatedStaff } from '../../middleware/auth.js';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite, type TestSqliteDatabase } from '../../custom/pharmacy/test-sqlite.js';
import { conversations } from './conversations.js';

describe('conversation collection tenant scope', () => {
  it('constrains list and count queries to the authenticated tenant', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async all() {
            queries.push({ sql, params: statement.params });
            return { results: [] };
          },
          async first() {
            queries.push({ sql, params: statement.params });
            return { total: 0 };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.route('/', conversations);

    const response = await app.request('/api/conversations', {}, { DB: db } as Env['Bindings']);

    expect(response.status).toBe(200);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) {
      expect(query.sql).toContain('tenant_line_accounts');
      expect(query.params).toContain('tenant-a');
    }
  });
});


describe('conversation pagination and bounded tag lookup', () => {
  let sqlite: TestSqliteDatabase;
  let db: D1Database;
  let app: Hono<Env>;
  let queries: Array<{ sql: string; params: unknown[] }>;
  let duplicateAcrossChunk: boolean;

  const isDataQuery = (sql: string) => /FROM friends f\b|FROM friend_tags ft\b|FROM messages_log WHERE friend_id =/u.test(sql);
  const listQueries = () => queries.filter((query) => isDataQuery(query.sql));

  function seedAccount(accountId: string, tenantId: string): void {
    sqlite.prepare(
      'INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?, ?, ?, ?, ?)',
    ).run(accountId, 'channel-' + accountId, accountId, 'synthetic-token', 'synthetic-secret');
    sqlite.prepare('INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES (?, ?)').run(tenantId, accountId);
  }

  function seedFriend(index: number, accountId = 'account-a') {
    const friendId = 'friend-' + accountId + '-' + String(index).padStart(3, '0');
    const createdAt = new Date(Date.parse('2023-01-01T00:00:00.000Z') + index * 1_000).toISOString();
    const content = 'Message ' + index + ': ' + 'x'.repeat(90);
    sqlite.prepare(
      'INSERT INTO friends (id, line_user_id, provider_line_user_id, display_name, line_account_id, is_following) VALUES (?, ?, ?, ?, ?, 1)',
    ).run(friendId, 'legacy-' + friendId, 'U-' + friendId, 'Friend ' + index, accountId);
    sqlite.prepare(
      "INSERT INTO messages_log (id, friend_id, direction, message_type, content, line_account_id, created_at) VALUES (?, ?, 'incoming', 'text', ?, ?, ?)",
    ).run('message-' + friendId, friendId, content, accountId, createdAt);
    // friend_tags enforces tenant scope (migration 025): attach the tag pair
    // owned by the friend's own tenant.
    const tagIds =
      accountId === 'account-b' ? ['tag-alpha-b', 'tag-beta-b'] : ['tag-alpha', 'tag-beta'];
    for (const tagId of tagIds) {
      sqlite.prepare('INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?)').run(friendId, tagId);
    }
    return {
      friendId, lineUserId: 'U-' + friendId, displayName: 'Friend ' + index,
      lineAccountId: accountId, lineAccountName: accountId, lastIncomingAt: createdAt,
      hoursSince: expect.any(Number), lastIncomingPreview: content.slice(0, 80),
      lastIncomingType: 'text', tags: ['alpha', 'beta'],
    };
  }

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      sqlite.prepare('INSERT INTO tenants (id, tenant_code, display_name) VALUES (?, ?, ?)').run(tenantId, tenantId, tenantId);
    }
    seedAccount('account-a', 'tenant-a');
    seedAccount('account-unassigned', 'tenant-a');
    seedAccount('account-b', 'tenant-b');
    sqlite.prepare("INSERT INTO staff_members (id, name, role, api_key, is_active) VALUES ('staff-a', 'Synthetic staff', 'admin', 'synthetic-key', 1)").run();
    sqlite.prepare("INSERT INTO tenant_staff_memberships (tenant_id, staff_id, role, is_active) VALUES ('tenant-a', 'staff-a', 'admin', 1)").run();
    sqlite.prepare(
      "INSERT INTO pharmacy_staff_accounts (line_account_id, staff_id, is_active, created_at, updated_at) VALUES ('account-a', 'staff-a', 1, ?, ?)",
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    sqlite.prepare("INSERT INTO tags (id, name, tenant_id) VALUES ('tag-alpha', 'alpha', 'tenant-a'), ('tag-beta', 'beta', 'tenant-a')").run();
    sqlite.prepare("INSERT INTO tags (id, name, tenant_id) VALUES ('tag-alpha-b', 'alpha-b', 'tenant-b'), ('tag-beta-b', 'beta-b', 'tenant-b')").run();
    queries = [];
    duplicateAcrossChunk = false;
    const underlying = d1FromSqlite(sqlite);
    const tracked = (sql: string, params: unknown[] = []): D1PreparedStatement => {
      const bound = underlying.prepare(sql).bind(...params);
      const record = () => {
        queries.push({ sql, params });
        if (params.length > 100) throw new Error('D1 bound-parameter limit exceeded');
      };
      return {
        bind: (...values: unknown[]) => tracked(sql, values),
        first: async () => {
          record();
          return bound.first();
        },
        all: async () => {
          record();
          const result = await bound.all<Record<string, unknown>>();
          if (duplicateAcrossChunk && sql.includes('LIMIT ? OFFSET ?')) {
            // Model an existing duplicated friend row independently of the later
            // latest-message tie fix. The tag SQL still runs against real rows.
            const rows = [...result.results];
            rows.splice(100, 0, rows[99]!);
            return { ...result, results: rows };
          }
          return result;
        },
      } as unknown as D1PreparedStatement;
    };
    db = { prepare: (sql: string) => tracked(sql) } as D1Database;
    app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      c.set('staff', { id: 'staff-a', role: 'admin' } as AuthenticatedStaff);
      await next();
    });
    app.route('/', conversations);
  });

  afterEach(() => sqlite.close());

  it.each([0, 1, 100, 101, 200])('returns %i conversations with bounded tag binds and unchanged fields', async (count) => {
    const expected = Array.from({ length: count }, (_, index) => seedFriend(index));
    seedFriend(0, 'account-unassigned');
    seedFriend(0, 'account-b');

    const response = await app.request('/api/conversations?limit=200', {}, { DB: db } as Env['Bindings']);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { total: count, items: expected } });
    const dataQueries = listQueries();
    const tagQueries = dataQueries.filter((query) => query.sql.includes('FROM friend_tags ft'));
    expect(dataQueries).toHaveLength(2 + Math.ceil(count / 100));
    expect(tagQueries).toHaveLength(Math.ceil(count / 100));
    expect(tagQueries.flatMap((query) => query.params)).toEqual(expected.map((item) => item.friendId));
    for (const query of queries) expect(query.params.length).toBeLessThanOrEqual(100);
    for (const query of dataQueries.filter((query) => query.sql.includes('FROM friends f'))) {
      expect(query.params).toContain('tenant-a');
      expect(query.params).toContain('staff-a');
    }
  });

  it.each([
    { query: '', offset: 0, size: 50 },
    { query: '?limit=9999', offset: 0, size: 200 },
    { query: '?limit=1e100', offset: 0, size: 200 },
    { query: '?limit=2&offset=3', offset: 3, size: 2 },
  ])('preserves list defaults, clamping and offsets for $query', async ({ query, offset, size }) => {
    const expected = Array.from({ length: 205 }, (_, index) => seedFriend(index));
    const response = await app.request('/api/conversations' + query, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, data: { total: 205, items: expected.slice(offset, offset + size) },
    });
    const main = listQueries().find((item) => item.sql.includes('LIMIT ? OFFSET ?'));
    expect(main?.params.slice(-2)).toEqual([size, offset]);
  });

  it('deduplicates lookup IDs before chunking without changing existing duplicate items or total', async () => {
    const expected = Array.from({ length: 101 }, (_, index) => seedFriend(index));
    duplicateAcrossChunk = true;
    const response = await app.request('/api/conversations?limit=200', {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, data: { total: 101, items: [...expected.slice(0, 100), expected[99], expected[100]] },
    });
    const tagQueries = listQueries().filter((query) => query.sql.includes('FROM friend_tags ft'));
    const ids = tagQueries.flatMap((query) => query.params);
    expect(ids).toEqual(expected.map((item) => item.friendId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(tagQueries.map((query) => query.params.length)).toEqual([100, 1]);
    expect(listQueries()).toHaveLength(4);
  });

  it('selects one deterministic latest incoming message when timestamps tie', async () => {
    const expected = seedFriend(0);
    sqlite.prepare(
      "INSERT INTO messages_log (id, friend_id, direction, message_type, content, line_account_id, created_at) VALUES ('zz-tied-message', ?, 'incoming', 'text', 'Tied winner', 'account-a', ?)",
    ).run(expected.friendId, expected.lastIncomingAt);

    const response = await app.request('/api/conversations', {}, { DB: db } as Env['Bindings']);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        total: 1,
        items: [{ ...expected, lastIncomingPreview: 'Tied winner' }],
      },
    });
  });

  it.each([
    'limit=', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=NaN', 'limit=Infinity',
    'offset=', 'offset=-1', 'offset=1.5', 'offset=NaN', 'offset=Infinity',
    'offset=9223372036854775808', 'offset=1e100',
  ])('rejects invalid list pagination %s before data retrieval', async (query) => {
    seedFriend(0);
    const response = await app.request('/api/conversations?' + query, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'limit / offset が不正です' });
    expect(listQueries()).toEqual([]);
  });

  it.each(['9007199254740991', '9007199254740992'])('preserves a supported huge offset %s as an empty page', async (offset) => {
    seedFriend(0);
    const response = await app.request('/api/conversations?offset=' + offset, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { total: 1, items: [] } });
    expect(listQueries()).toHaveLength(2);
    expect(listQueries().find((query) => query.sql.includes('LIMIT ? OFFSET ?'))?.params.slice(-2)).toEqual([50, Number(offset)]);
  });

  it.each(['account-unassigned', 'account-b'])('does not treat the account filter %s as authorization', async (accountId) => {
    seedFriend(0);
    seedFriend(0, accountId);
    const response = await app.request('/api/conversations?lineAccountId=' + accountId, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { total: 0, items: [] } });
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity'])('rejects invalid detail limit=%s before data retrieval', async (limit) => {
    const friend = seedFriend(0);
    const response = await app.request('/api/conversations/' + friend.friendId + '?limit=' + limit, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'limit が不正です' });
    expect(listQueries()).toEqual([]);
  });

  it.each([
    { query: '', size: 50 },
    { query: '?limit=9999', size: 200 },
    { query: '?limit=1&offset=invalid', size: 1 },
  ])('preserves detail limit, chronological messages and ignored offset for $query', async ({ query, size }) => {
    const friend = seedFriend(0);
    const expected = [{
      id: 'message-' + friend.friendId, direction: 'incoming', messageType: 'text',
      content: 'Message 0: ' + 'x'.repeat(90), deliveryType: null, source: 'user', createdAt: friend.lastIncomingAt,
    }];
    for (let index = 1; index < 205; index += 1) {
      const createdAt = new Date(Date.parse(friend.lastIncomingAt) + index * 1_000).toISOString();
      const id = 'detail-message-' + index;
      sqlite.prepare(
        "INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at) VALUES (?, ?, 'incoming', 'text', ?, ?)",
      ).run(id, friend.friendId, 'Detail ' + index, createdAt);
      expected.push({ id, direction: 'incoming', messageType: 'text', content: 'Detail ' + index, deliveryType: null, source: 'user', createdAt });
    }
    const response = await app.request('/api/conversations/' + friend.friendId + query, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        friend: {
          friendId: friend.friendId, lineUserId: friend.lineUserId, displayName: friend.displayName,
          lineAccountId: friend.lineAccountId, lineAccountName: friend.lineAccountName,
          isFollowing: true, tags: ['alpha', 'beta'],
        },
        messages: expected.slice(-size),
      },
    });
  });

  it('preserves the detail before cursor at sub-second precision', async () => {
    const friend = seedFriend(0);
    sqlite.prepare(
      "INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at) VALUES ('cursor-message', ?, 'incoming', 'text', 'later', '2023-01-01T00:00:00.500Z')",
    ).run(friend.friendId);
    const response = await app.request('/api/conversations/' + friend.friendId + '?limit=1&before=2023-01-01T00:00:00.500Z', {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { messages: Array<{ id: string }> } };
    expect(body.data.messages).toHaveLength(1);
    expect(body.data.messages[0].id).toBe('message-' + friend.friendId);
  });

  it('keeps the detail tenant predicate', async () => {
    const friend = seedFriend(0, 'account-b');
    const response = await app.request('/api/conversations/' + friend.friendId, {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'friend not found' });
  });
});
