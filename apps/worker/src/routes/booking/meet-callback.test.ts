import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createBroadcastRetryKey } from '../../services/broadcast-retry-key.js';
import type { Env } from '../../index.js';

const dbMocks = {
  getFriendByLineUserId: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getLineAccountById: vi.fn(),
  getLineAccountByIdForTenant: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const pushMessage = vi.fn();
const LineClientMock = vi.fn().mockImplementation(function () {
  return { pushMessage };
});
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: LineClientMock,
}));

const deliverTrackedLinePush = vi.fn(async (params: {
  request: { to: string; messages: unknown[] };
  operationId: string;
  send: (request: { to: string; messages: unknown[] }, retryKey: string) => Promise<void>;
}): Promise<'sent' | 'already_sent' | 'reconciliation_required'> => {
  await params.send(params.request, params.operationId);
  return 'sent';
});
vi.mock('../../services/outbound-line-delivery.js', () => ({ deliverTrackedLinePush }));

const { meetCallback } = await import('./meet-callback.js');

const updateFriend = vi.fn(async () => ({ meta: { changes: 1 } }));
const database = {
  prepare: () => ({
    bind: () => ({ run: updateFriend }),
  }),
} as unknown as D1Database;

function app() {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-1');
    await next();
  });
  root.route('/', meetCallback);
  return root;
}

const bindings = { DB: database } as Env['Bindings'];

const payload = {
  session_id: 'session-1',
  scenario_id: 'scenario-1',
  line_user_id: 'U1',
  line_account_id: 'account-1',
  status: 'completed',
  transcripts: [],
  completed_at: '2026-08-30T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFriendByLineUserId.mockResolvedValue({
    id: 'friend-1',
    line_user_id: 'U1',
    line_account_id: 'account-1',
    display_name: 'A',
    metadata: '{}',
  });
  dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue({
    id: 'friend-1',
    line_user_id: 'U1',
    line_account_id: 'account-1',
    display_name: 'A',
    metadata: '{}',
  });
  dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'token-1' });
  dbMocks.getLineAccountByIdForTenant.mockResolvedValue({ id: 'account-1' });
  pushMessage.mockResolvedValue({});
  updateFriend.mockResolvedValue({ meta: { changes: 1 } });
});

describe('POST /api/meet-callback', () => {
  it('requires the stable source session before sending', async () => {
    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, session_id: undefined }),
    }, bindings);

    expect(response.status).toBe(400);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('rejects non-string account selectors before tenant lookup', async () => {
    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, line_account_id: { id: 'account-1' } }),
    }, bindings);

    expect(response.status).toBe(400);
    expect(dbMocks.getLineAccountByIdForTenant).not.toHaveBeenCalled();
  });

  it('rejects malformed transcripts before account lookup or sending', async () => {
    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, transcripts: { transcript: 'not-an-array' } }),
    }, bindings);

    expect(response.status).toBe(400);
    expect(dbMocks.getLineAccountByIdForTenant).not.toHaveBeenCalled();
    expect(deliverTrackedLinePush).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before account lookup or sending', async () => {
    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }, bindings);

    expect(response.status).toBe(400);
    expect(dbMocks.getLineAccountByIdForTenant).not.toHaveBeenCalled();
    expect(deliverTrackedLinePush).not.toHaveBeenCalled();
  });

  it('returns a retryable failure when LINE delivery throws', async () => {
    deliverTrackedLinePush.mockRejectedValueOnce(new Error('LINE unavailable'));

    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(503);
  });

  it('requires reconciliation instead of reporting delivery success', async () => {
    deliverTrackedLinePush.mockResolvedValueOnce('reconciliation_required');

    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(409);
  });

  it('does not report success when the scoped metadata update loses its target', async () => {
    updateFriend.mockResolvedValueOnce({ meta: { changes: 0 } });

    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(500);
  });

  it('reuses one provider retry key when the callback is delivered again', async () => {
    const request = () => app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);

    const expectedKey = await createBroadcastRetryKey(
      'meet-callback', 'friend-1', payload.session_id,
    );
    expect(pushMessage).toHaveBeenCalledTimes(2);
    expect(pushMessage.mock.calls.map((call) => call[2])).toEqual([expectedKey, expectedKey]);
  });

  it('reserves the tenant-scoped outbound ledger before LINE', async () => {
    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(200);
    const operationId = await createBroadcastRetryKey(
      'meet-callback', 'friend-1', payload.session_id,
    );
    expect(deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      tenantId: 'tenant-1',
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      source: 'meet-callback',
    }));
    expect(deliverTrackedLinePush.mock.invocationCallOrder[0])
      .toBeLessThan(pushMessage.mock.invocationCallOrder[0]);
  });

  it('resolves the account under authenticated tenant authority before the friend', async () => {
    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(200);
    expect(dbMocks.getLineAccountByIdForTenant)
      .toHaveBeenCalledWith(database, 'tenant-1', 'account-1');
    expect(dbMocks.getFriendByLineUserIdForAccount)
      .toHaveBeenCalledWith(database, 'U1', 'account-1');
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  it('rejects an account outside the authenticated tenant before sending', async () => {
    dbMocks.getLineAccountByIdForTenant.mockResolvedValue(null);

    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(404);
    expect(dbMocks.getFriendByLineUserIdForAccount).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the owned account credential cannot be resolved', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(null);

    const response = await app().request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, bindings);

    expect(response.status).toBe(403);
    expect(LineClientMock).not.toHaveBeenCalled();
    expect(deliverTrackedLinePush).not.toHaveBeenCalled();
  });
});
