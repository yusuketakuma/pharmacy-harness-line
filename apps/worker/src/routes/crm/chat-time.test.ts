import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import { Sqlite, d1FromSqlite, DB_PACKAGE_ROOT, type TestSqliteDatabase } from '../../custom/pharmacy/test-sqlite.js';
import { countUnanswered, computeUnansweredInbox } from '../../services/unanswered-inbox.js';
import { conversations } from './conversations.js';
import { chats } from './chats.js';

let sqlite: TestSqliteDatabase;
let db: D1Database;
let app: Hono<Env>;
function friend(id = 'friend-a') {
  sqlite
    .prepare(`INSERT INTO friends(id,line_user_id,provider_line_user_id,display_name,line_account_id,is_following)
    VALUES(?,?,?,?,'account-a',1)`)
    .run(id, id, id, id);
}
function message(
  id: string,
  at: string,
  direction = 'incoming',
  friendId = 'friend-a',
  source = direction === 'incoming' ? 'user' : 'manual',
  deliveryType: string | null = null,
) {
  sqlite
    .prepare(`INSERT INTO messages_log(id,friend_id,line_account_id,direction,message_type,content,source,delivery_type,created_at)
    VALUES(?,?,'account-a',?,'text',?,?,?,?)`)
    .run(id, friendId, direction, id, source, deliveryType, at);
}
async function get(path: string) {
  const response = await app.request(path, {}, { DB: db } as Env['Bindings']);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ data: any }>;
}
beforeEach(() => {
  sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`INSERT INTO tenants(id,tenant_code,display_name) VALUES('tenant-a','tenant-a','Synthetic');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('account-a','channel-a','Synthetic','synthetic-token','synthetic-secret');
    INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('tenant-a','account-a');
    INSERT INTO staff_members(id,name,role,api_key,is_active) VALUES('staff-a','Synthetic','admin','synthetic-key',1);
    INSERT INTO tenant_staff_memberships(tenant_id,staff_id,role,is_active) VALUES('tenant-a','staff-a','admin',1);
    INSERT INTO pharmacy_staff_accounts(line_account_id,staff_id,is_active,created_at,updated_at) VALUES('account-a','staff-a',1,'2023-01-01T00:00:00Z','2023-01-01T00:00:00Z');`);
  db = d1FromSqlite(sqlite);
  app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    c.set('staff', { id: 'staff-a', name: 'Synthetic', role: 'admin' });
    await next();
  });
  app.route('/', conversations);
  app.route('/', chats);
  friend();
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

describe('chat timestamps compare instants while preserving stored strings', () => {
  it.each([
    ['2023-01-01T09:00:00.000+09:00', '2023-01-01T00:01:00.000Z'],
    ['2023-01-01T00:00:00.000Z', '2023-01-01T09:01:00.000+09:00'],
    ['2023-01-01T00:00:00.000Z', '2023-01-01T00:01:00.000Z'],
    ['2023-01-01T09:00:00.000+09:00', '2023-01-01T09:01:00.000+09:00'],
    ['2023-01-02T00:00:00.100+09:00', '2023-01-01T15:00:00.200Z'],
  ])('orders history and removes answered work for %s → %s', async (incoming, outgoing) => {
    message('incoming', incoming);
    message('outgoing', outgoing, 'outgoing');
    const first = (await get('/api/conversations/friend-a?limit=1')).data.messages;
    expect(first.map((m: any) => m.id)).toEqual(['outgoing']);
    expect(first[0].createdAt).toBe(outgoing);
    const second = (await get('/api/conversations/friend-a?limit=1&before=' + encodeURIComponent(first[0].createdAt)))
      .data.messages;
    expect(second.map((m: any) => m.id)).toEqual(['incoming']);
    const detail = (await get('/api/conversations/friend-a')).data.messages;
    expect(detail.map((m: any) => m.id)).toEqual(['incoming', 'outgoing']);
    const chat = (await get('/api/chats/friend-a')).data;
    expect(chat.messages.map((m: any) => m.id)).toEqual(['incoming', 'outgoing']);
    const list = (await get('/api/chats')).data;
    expect(list[0]).toMatchObject({
      lastMessageDirection: 'outgoing',
      lastMessageContent: 'outgoing',
      lastMessageAt: outgoing,
    });
    expect((await get('/api/conversations?minHoursSince=0')).data).toEqual({ total: 0, items: [] });
    expect((await countUnanswered(db, 'tenant-a')).total).toBe(0);
  });

  it('uses one clock for list cursors, even when chat metadata is newer than its preview', async () => {
    friend('friend-b');
    friend('friend-c');
    message('a', '2023-01-01T09:00:00.000+09:00');
    message('b', '2023-01-01T00:00:30.000Z', 'incoming', 'friend-b');
    message('c', '2023-01-01T09:00:30.000+09:00', 'incoming', 'friend-c');
    sqlite
      .prepare(
        `INSERT INTO chats(id,friend_id,last_message_at,status) VALUES('chat-a','friend-a','2023-01-01T00:01:00.000Z','unread')`,
      )
      .run();
    const ids: string[] = [];
    let cursor = '';
    for (let page = 0; page < 3; page++) {
      const list = (await get('/api/chats?limit=1' + cursor)).data;
      expect(list).toHaveLength(1);
      ids.push(list[0].id);
      cursor =
        '&beforeAt=' + encodeURIComponent(new Date(list[0].lastMessageAt).toISOString()) + '&beforeId=' + list[0].id;
    }
    expect(ids).toEqual(['friend-c', 'friend-b', 'friend-a']);
    expect((await get('/api/chats?limit=1' + cursor)).data).toEqual([]);
  });

  it('keeps chat-only timestamps and NULL when no message history exists', async () => {
    friend('friend-b');
    sqlite.exec(`INSERT INTO chats(id,friend_id,status,last_message_at) VALUES
      ('empty-a','friend-a','unread',NULL),
      ('empty-b','friend-b','unread','2023-01-01T09:00:00.000+09:00');`);
    const list = (await get('/api/chats?status=unread')).data;
    expect(list.map((x: any) => [x.id, x.lastMessageAt, x.lastMessageContent])).toEqual([
      ['friend-b', '2023-01-01T09:00:00.000+09:00', null],
      ['friend-a', null, null],
    ]);
  });

  it('keeps raw argmax timestamps for multiple incoming/manual formats and sorts inbox by instant', async () => {
    friend('friend-b');
    message('older', '2023-01-01T09:00:00.000+09:00');
    message('newer', '2023-01-01T00:02:00.000Z');
    message('manual-old', '2022-12-31T23:59:00.000Z', 'outgoing');
    message('manual-new', '2023-01-01T09:01:00.000+09:00', 'outgoing');
    message('b', '2023-01-01T09:01:30.000+09:00', 'incoming', 'friend-b');
    const queue = (await get('/api/conversations?minHoursSince=0')).data;
    expect(queue.total).toBe(2);
    expect(queue.items.map((x: any) => x.friendId)).toEqual(['friend-b', 'friend-a']);
    expect(queue.items[1]).toMatchObject({
      lastIncomingAt: '2023-01-01T00:02:00.000Z',
      lastIncomingPreview: 'newer',
    });
    const inbox = await computeUnansweredInbox(db, 'tenant-a');
    expect(inbox.rows.map((x) => x.friendId)).toEqual(['friend-a', 'friend-b']);
    expect(inbox.rows[0]).toMatchObject({
      lastIncomingAt: '2023-01-01T00:02:00.000Z',
      lastManualAt: '2023-01-01T09:01:00.000+09:00',
      lastIncomingContent: 'newer',
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2023-01-01T00:03:40.000Z'));
    expect((await countUnanswered(db, 'tenant-a')).oldestWaitMinutes).toBe(2);
    expect((await computeUnansweredInbox(db, 'tenant-a', { minWaitMinutes: 2 })).rows.map((x) => x.friendId)).toEqual([
      'friend-b',
    ]);
    message('manual-latest', '2023-01-01T00:02:01.000Z', 'outgoing');
    expect((await computeUnansweredInbox(db, 'tenant-a')).rows.map((x) => x.friendId)).toEqual(['friend-b']);
    expect((await get('/api/conversations?minHoursSince=0')).data.total).toBe(1);
  });

  it('preserves strict timestamp-only before for equal instants and excludes test sends from chats', async () => {
    message('a', '2023-01-01T09:00:00.100+09:00');
    message('b', '2023-01-01T00:00:00.100Z');
    message('test', '2023-01-02T00:00:00Z', 'outgoing', 'friend-a', 'broadcast', 'test');
    const detail = (await get('/api/conversations/friend-a?before=2023-01-01T00:00:00.100Z')).data.messages;
    expect(detail).toEqual([]);
    const list = (await get('/api/chats')).data;
    expect(['a', 'b']).toContain(list[0].lastMessageContent);
    const chat = (await get('/api/chats/friend-a')).data;
    expect(chat.messages.map((m: any) => m.id)).toEqual(['a', 'b']);
  });

  it('consumes mixed-offset auto-reply evidence once and keeps a later unanswered incoming', async () => {
    message('older', '2023-01-01T09:00:00.000+09:00');
    message('middle', '2023-01-01T00:00:01.000Z');
    message('reply', '2023-01-01T09:00:02.000+09:00', 'outgoing', 'friend-a', 'auto_reply', 'reply');
    const inbox = await computeUnansweredInbox(db, 'tenant-a');
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].lastIncomingContent).toBe('older');
    message('later', '2023-01-01T00:00:06.000Z');
    expect((await computeUnansweredInbox(db, 'tenant-a')).rows[0].lastIncomingContent).toBe('later');
  });
});
