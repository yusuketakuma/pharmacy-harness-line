import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  createChat: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: dbMocks.createChat,
  getFriendById: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-08-18T00:00:00.000Z'),
}));

import { chats } from './chats.js';

function mount(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/', chats);
  return { app, env: { DB: db } as Env['Bindings'] };
}

describe('POST /api/chats tenant pair scope', () => {
  it('rejects a friend and requested LINE account that are not the same tenant-owned pair', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          params: [] as unknown[],
          bind(...params: unknown[]) {
            statement.params = params;
            return statement;
          },
          async first() {
            queries.push({ sql, params: statement.params });
            return null;
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    dbMocks.createChat.mockResolvedValue({
      id: 'chat-a',
      friend_id: 'friend-a',
      status: 'resolved',
    });
    const { app, env } = mount(db);

    const response = await app.request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-a', lineAccountId: 'account-b' }),
    }, env);

    expect(response.status).toBe(403);
    expect(dbMocks.createChat).not.toHaveBeenCalled();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('FROM friends');
    expect(queries[0]?.sql).toContain('tenant_line_accounts');
    expect(queries[0]?.sql).toContain('line_account_id');
    expect(queries[0]?.params).toEqual(['tenant-a', 'friend-a', 'account-b']);
  });
});
