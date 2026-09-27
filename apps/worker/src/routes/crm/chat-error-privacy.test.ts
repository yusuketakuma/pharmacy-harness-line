import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite, type TestSqliteDatabase } from '../../custom/pharmacy/test-sqlite.js';
import { chats } from './chats.js';
import { conversations } from './conversations.js';

const PRIVATE_MARKER = 'PHI_MARK';
let sqlite: TestSqliteDatabase;
let db: D1Database;
let app: Hono<Env>;

beforeEach(() => {
  sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.exec(`INSERT INTO tenants(id,tenant_code,display_name) VALUES('tenant-a','tenant-a','Synthetic');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('account-a','channel-a','Synthetic','synthetic-token','synthetic-secret');
    INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES('tenant-a','account-a');
    INSERT INTO staff_members(id,name,role,api_key,is_active) VALUES('staff-a','Synthetic','admin','synthetic-key',1);
    INSERT INTO tenant_staff_memberships(tenant_id,staff_id,role,is_active) VALUES('tenant-a','staff-a','admin',1);
    INSERT INTO pharmacy_staff_accounts(line_account_id,staff_id,is_active,created_at,updated_at) VALUES('account-a','staff-a',1,'2023-01-01T00:00:00Z','2023-01-01T00:00:00Z');
    INSERT INTO friends(id,line_user_id,provider_line_user_id,display_name,line_account_id) VALUES('friend-a','synthetic-user','synthetic-user','Synthetic','account-a');
    INSERT INTO chats(id,friend_id,notes) VALUES('chat-a','friend-a','original');`);
  db = d1FromSqlite(sqlite);
  app = new Hono<Env>();
  // Synthetic authenticated identity: actual route/helper/SQL, not full auth.
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    c.set('staff', { id: 'staff-a', name: 'Synthetic', role: 'admin' });
    await next();
  });
  app.route('/', chats);
  app.route('/', conversations);
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

async function expectPrivateFailure(method: string, path: string, event: string, database: D1Database, body?: string) {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const response = await app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    },
    { DB: database } as Env['Bindings'],
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ success: false, error: 'Internal server error' });
  const emitted = [...error.mock.calls, ...warn.mock.calls, ...log.mock.calls].flat().map(String).join(' ');
  expect(emitted).not.toContain(PRIVATE_MARKER);
  expect(error).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({
    ts: expect.any(String),
    level: 'error',
    event,
  });
}

describe('CRM exception privacy', () => {
  it.each([
    ['POST', '/api/operators', 'operator_create_failed'],
    ['PUT', '/api/operators/operator-a', 'operator_update_failed'],
    ['POST', '/api/chats', 'chat_create_failed'],
    ['PUT', '/api/chats/chat-a', 'chat_update_failed'],
  ])('keeps malformed %s %s bodies out of logs', async (method, path, event) => {
    await expectPrivateFailure(method, path, event, db, PRIVATE_MARKER);
    expect(sqlite.prepare("SELECT notes FROM chats WHERE id='chat-a'").get()).toEqual({
      notes: 'original',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM operators').get()).toEqual({ n: 0 });
  });

  it.each([
    ['GET', '/api/operators', 'operator_list_failed', undefined],
    ['POST', '/api/operators', 'operator_create_failed', { name: 'Synthetic', email: 'synthetic@example.invalid' }],
    ['PUT', '/api/operators/operator-a', 'operator_update_failed', { name: 'Synthetic' }],
    ['DELETE', '/api/operators/operator-a', 'operator_delete_failed', undefined],
    ['GET', '/api/chats', 'chat_list_failed', undefined],
    ['GET', '/api/chats/chat-a', 'chat_detail_failed', undefined],
    ['POST', '/api/chats', 'chat_create_failed', { friendId: 'friend-a' }],
    ['PUT', '/api/chats/chat-a', 'chat_update_failed', { notes: 'Synthetic' }],
    ['GET', '/api/conversations', 'conversation_list_failed', undefined],
    ['GET', '/api/conversations/friend-a', 'conversation_detail_failed', undefined],
  ] as const)('keeps dependency errors private for %s %s', async (method, path, event, body) => {
    const failingDb = {
      prepare() {
        throw new Error(PRIVATE_MARKER);
      },
    } as unknown as D1Database;
    await expectPrivateFailure(method, path, event, failingDb, body === undefined ? undefined : JSON.stringify(body));
  });
});
