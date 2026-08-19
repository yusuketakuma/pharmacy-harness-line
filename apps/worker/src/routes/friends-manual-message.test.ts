import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  pushMessage: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
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
  getFriends: vi.fn(),
  addTagToFriend: vi.fn(),
  removeTagFromFriend: vi.fn(),
  getFriendTags: vi.fn(),
  getFormSubmissionsByFriend: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getMileageSummaryForFriend: vi.fn(),
  getMileageHistoryForFriend: vi.fn(),
}));

vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentialMocks);
vi.mock('../middleware/tenant-boundary.js', () => boundaryMocks);

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => lineClientMocks),
}));

vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(),
  appendFriendToTrackedLinks: vi.fn(async (_db: D1Database, content: string) => content),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((messageType: string, content: string) => ({ type: messageType, text: content })),
}));

vi.mock('../services/event-bus.js', () => ({ fireEvent: vi.fn() }));

import type { Env } from '../index.js';
import { getFriendById, getLineAccountById } from '@line-crm/db';
import { readLineCredential } from '../custom/pharmacy/provisioning/line-credential-store.js';
import { friends } from './friends.js';

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
    WORKER_URL: 'https://worker.example.test',
  } as unknown as Env['Bindings'];
}

function setup(db: D1Database, tenantId = 'tenant-a') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    await next();
  });
  app.route('/', friends);
  return app;
}

function request(app: Hono<Env>, env: Env['Bindings']) {
  return app.request('/api/friends/friend-a/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Harness-Source': 'manual',
    },
    body: JSON.stringify({ content: 'hello from staff', trackLinks: false }),
  }, env);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFriendById.mockResolvedValue(FRIEND);
  lineClientMocks.pushMessage.mockResolvedValue(undefined);
  boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
});

describe('manual friend message credentials', () => {
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
    expect(lineClientMocks.pushMessage).toHaveBeenCalledWith(
      FRIEND.line_user_id,
      [{ type: 'text', text: 'hello from staff' }],
    );
    expect(executions.some(({ sql }) => sql.includes("'manual'"))).toBe(true);
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
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes('INSERT INTO messages_log'))).toBe(false);
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
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes('INSERT INTO messages_log'))).toBe(false);
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
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes('INSERT INTO messages_log'))).toBe(false);
  });
});
