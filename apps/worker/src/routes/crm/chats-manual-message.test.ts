import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  pushTextMessage: vi.fn(),
  pushFlexMessage: vi.fn(),
  pushImageMessage: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getChatById: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => '2026-08-18T12:00:00.000+09:00'),
}));

const credentialMocks = vi.hoisted(() => ({
  readLineCredential: vi.fn(),
}));

const boundaryMocks = vi.hoisted(() => ({
  accountResourceOwnedByStaff: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  ...dbMocks,
  getOperators: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  createChat: vi.fn(),
}));

vi.mock('../../custom/pharmacy/provisioning/line-credential-store.js', () => credentialMocks);
vi.mock('../../middleware/tenant-boundary.js', () => boundaryMocks);

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return lineClientMocks; }),
}));

import type { Env } from '../../index.js';
import { getChatById, getFriendById, getLineAccountById, updateChat } from '@line-crm/db';
import { readLineCredential } from '../../custom/pharmacy/provisioning/line-credential-store.js';
import { chats } from './chats.js';

const ROOT_SECRET = 'synthetic-line-credential-root-key-v1';
const FRIEND = {
  id: 'friend-a',
  line_user_id: 'U00000000000000000000000000000001',
  line_account_id: 'account-a',
};

type Execution = { sql: string; params: unknown[] };

function makeDb(): { db: D1Database; executions: Execution[] } {
  const executions: Execution[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        params: [] as unknown[],
        async run() {
          executions.push({ sql, params: statement.params });
          return { meta: { changes: 1 } };
        },
        async first() {
          executions.push({ sql, params: statement.params });
          return null;
        },
        async all() {
          executions.push({ sql, params: statement.params });
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, executions };
}

function bindings(db: D1Database, rootSecret?: string): Env['Bindings'] {
  return {
    DB: db,
    LINE_CHANNEL_ACCESS_TOKEN: 'legacy-global-token',
    LINE_CREDENTIAL_KEY_V1: rootSecret,
  } as unknown as Env['Bindings'];
}

function setup(db: D1Database, tenantId = 'tenant-a') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    await next();
  });
  app.route('/', chats);
  return app;
}

function request(app: Hono<Env>, env: Env['Bindings']) {
  return app.request('/api/chats/chat-a/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Harness-Source': 'manual',
    },
    body: JSON.stringify({ content: 'hello from staff' }),
  }, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getChatById.mockResolvedValue({ id: 'chat-a', friend_id: FRIEND.id, status: 'resolved' });
  dbMocks.getFriendById.mockResolvedValue(FRIEND);
  dbMocks.updateChat.mockResolvedValue(undefined);
  lineClientMocks.pushTextMessage.mockResolvedValue(undefined);
  boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
});

afterEach(() => vi.unstubAllGlobals());

describe('manual chat message credentials', () => {
  it('reads the tenant-bound credential and keeps the manual audit row', async () => {
    const { db, executions } = makeDb();
    credentialMocks.readLineCredential.mockResolvedValue('tenant-account-token');

    const response = await request(setup(db), bindings(db, ROOT_SECRET));

    expect(response.status).toBe(200);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      kind: 'channel_access_token',
    });
    expect(getLineAccountById).not.toHaveBeenCalled();
    expect(lineClientMocks.pushTextMessage).toHaveBeenCalledWith(
      FRIEND.line_user_id,
      'hello from staff',
    );
    expect(executions.some(({ sql }) => sql.includes("'manual'"))).toBe(true);
    expect(updateChat).toHaveBeenCalled();
  });

  it.each([
    ['the root key is missing', undefined, false],
    ['the credential is missing or invalid', ROOT_SECRET, true],
  ])('fails closed when %s', async (_reason, rootSecret, shouldReadStore) => {
    const { db, executions } = makeDb();
    credentialMocks.readLineCredential.mockResolvedValue(null);

    const response = await request(setup(db), bindings(db, rootSecret));

    expect(response.status).toBe(403);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledTimes(shouldReadStore ? 1 : 0);
    expect(lineClientMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes('INSERT INTO messages_log'))).toBe(false);
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('fails closed when the friend account is outside the authenticated tenant', async () => {
    const { db, executions } = makeDb();
    credentialMocks.readLineCredential.mockResolvedValue(null);

    const response = await request(setup(db, 'tenant-b'), bindings(db, ROOT_SECRET));

    expect(response.status).toBe(403);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(db, ROOT_SECRET, {
      tenantId: 'tenant-b',
      lineAccountId: 'account-a',
      kind: 'channel_access_token',
    });
    expect(lineClientMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes('INSERT INTO messages_log'))).toBe(false);
  });

  it('uses the same tenant credential for the LINE loading animation', async () => {
    const { db } = makeDb();
    credentialMocks.readLineCredential.mockResolvedValue('tenant-account-token');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await setup(db).request('/api/chats/chat-a/loading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loadingSeconds: 5 }),
    }, bindings(db, ROOT_SECRET));

    expect(response.status).toBe(200);
    expect(credentialMocks.readLineCredential).toHaveBeenCalledWith(db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      kind: 'channel_access_token',
    });
    expect(getLineAccountById).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/chat/loading/start',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tenant-account-token' }),
      }),
    );
  });

  it('keeps a LINE loading error body out of the response and logs', async () => {
    const { db } = makeDb();
    credentialMocks.readLineCredential.mockResolvedValue('tenant-account-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('sensitive-upstream-detail', { status: 503 }),
    ));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await setup(db).request('/api/chats/chat-a/loading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loadingSeconds: 5 }),
    }, bindings(db, ROOT_SECRET));

    const body = await response.text();
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(response.status).toBe(500);
    expect(body).not.toContain('sensitive-upstream-detail');
    expect(logged).toContain('chat_loading_start_failed');
    expect(logged).not.toContain('sensitive-upstream-detail');
  });

  it('denies an unassigned account in the same tenant before sending to LINE', async () => {
    const { db, executions } = makeDb();
    dbMocks.getFriendById.mockResolvedValue({ ...FRIEND, line_account_id: 'account-b' });
    credentialMocks.readLineCredential.mockResolvedValue('account-b-token');
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);

    const response = await request(setup(db), bindings(db, ROOT_SECRET));

    expect(response.status).toBe(403);
    expect(boundaryMocks.accountResourceOwnedByStaff).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'account-b',
    );
    expect(credentialMocks.readLineCredential).not.toHaveBeenCalled();
    expect(lineClientMocks.pushTextMessage).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes('INSERT INTO messages_log'))).toBe(false);
    expect(updateChat).not.toHaveBeenCalled();
  });
});
