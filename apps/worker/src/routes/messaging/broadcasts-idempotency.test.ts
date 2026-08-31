import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
const lineSdkMocks = {
  pushMessage: vi.fn(),
};
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessage = lineSdkMocks.pushMessage;
  },
}));

const boundaryMocks = vi.hoisted(() => ({
  accountOwned: vi.fn(),
}));
vi.mock('../../middleware/tenant-boundary.js', () => ({
  accountResourceOwnedByStaff: boundaryMocks.accountOwned,
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverTrackedLinePush: vi.fn(),
}));
vi.mock('../../services/outbound-line-delivery.js', () => deliveryMocks);

const { broadcasts } = await import('./broadcasts.js');
const { createBroadcastRetryKey } = await import('../../services/broadcast-retry-key.js');

const KEY = '11111111-2222-4333-8444-555555555555';
const requestBody = {
  title: '朝のお知らせ',
  messageType: 'text',
  messageContent: '{{name}}さん、おはようございます',
  targetType: 'all',
  scheduledAt: '2026-08-12T09:00:00.000+09:00',
  lineAccountId: 'account-1',
  trackLinks: true,
};

const row = {
  id: KEY,
  title: requestBody.title,
  message_type: requestBody.messageType,
  message_content: requestBody.messageContent,
  target_type: requestBody.targetType,
  target_tag_id: null,
  status: 'scheduled',
  scheduled_at: requestBody.scheduledAt,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-08-11T12:00:00.000+09:00',
  account_ids: null,
  dedup_priority: null,
  failed_account_ids: null,
  dedup_progress: null,
  batch_lock_at: null,
  track_links: 1,
  line_account_id: requestBody.lineAccountId,
  alt_text: null,
};

function setupApp(db: D1Database = {} as D1Database, tenantId?: string) {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    if (tenantId) c.set('tenantId' as never, tenantId as never);
    await next();
  });
  app.route('/', broadcasts);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  lineSdkMocks.pushMessage.mockReset().mockResolvedValue({ requestId: 'request-1' });
  boundaryMocks.accountOwned.mockReset().mockResolvedValue(true);
  deliveryMocks.deliverTrackedLinePush.mockReset().mockImplementation(async (params) => {
    await params.send(params.request, params.operationId);
    return 'sent';
  });
});
describe('POST /api/broadcasts idempotency', () => {
  test('creates with the idempotency key as the stable broadcast id', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(null);
    dbMocks.createBroadcast.mockResolvedValueOnce(row);

    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: KEY,
      lineAccountId: 'account-1',
      messageContent: requestBody.messageContent,
    }));
  });

  test('returns the original row without creating a duplicate on replay', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);

    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
    expect((await response.json() as { data: { id: string } }).data.id).toBe(KEY);
  });

  test('rejects reuse of the same key for different content', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);

    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify({ ...requestBody, messageContent: '別の内容' }),
    });

    expect(response.status).toBe(409);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects a malformed key before touching the database', async () => {
    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'not-a-uuid' },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(400);
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });
});

describe('POST /api/broadcasts/:id/test-send idempotency', () => {
  test('requires a request key before loading the broadcast', async () => {
    const response = await setupApp().request('/api/broadcasts/broadcast-1/test-send', {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
  });

  test('hides a broadcast owned by another tenant before account reads or LINE', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'draft',
    });
    boundaryMocks.accountOwned.mockResolvedValue(false);

    const response = await setupApp(db, 'tenant-a').request(
      '/api/broadcasts/broadcast-1/test-send',
      { method: 'POST', headers: { 'Idempotency-Key': KEY } },
    );

    expect(response.status).toBe(404);
    expect(boundaryMocks.accountOwned).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'account-1',
    );
    expect(db.prepare).not.toHaveBeenCalled();
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(lineSdkMocks.pushMessage).not.toHaveBeenCalled();
  });

  test('does not reveal a foreign broadcast status before tenant ownership', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'scheduled',
    });
    boundaryMocks.accountOwned.mockResolvedValue(false);

    const response = await setupApp(db, 'tenant-a').request(
      '/api/broadcasts/broadcast-1/test-send',
      { method: 'POST', headers: { 'Idempotency-Key': KEY } },
    );

    expect(response.status).toBe(404);
    expect(boundaryMocks.accountOwned).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'account-1',
    );
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('requires tenant authority before account reads or LINE', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'draft',
    });

    const response = await setupApp(db).request('/api/broadcasts/broadcast-1/test-send', {
      method: 'POST',
      headers: { 'Idempotency-Key': KEY },
    });

    expect(response.status).toBe(404);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(deliveryMocks.deliverTrackedLinePush).not.toHaveBeenCalled();
  });

  test('derives a stable recipient retry key from the request key', async () => {
    const run = vi.fn().mockResolvedValue({ success: true });
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            sql.includes('account_settings') ? { value: '["friend-1"]' } : null,
          ),
          all: vi.fn().mockResolvedValue({
            results: sql.includes('FROM friends')
              ? [{ id: 'friend-1', line_user_id: 'U-one', display_name: 'One' }]
              : [],
          }),
          run,
        })),
      })),
    } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'draft',
      track_links: 0,
    });
    dbMocks.getLineAccountById.mockResolvedValue({
      id: 'account-1',
      channel_access_token: 'line-token',
      liff_id: null,
    });

    const response = await setupApp(db, 'tenant-a').request('/api/broadcasts/broadcast-1/test-send', {
      method: 'POST',
      headers: { 'Idempotency-Key': KEY },
    });

    const operationId = await createBroadcastRetryKey(
      'broadcast-test-send-v1',
      'tenant-a',
      'account-1',
      'broadcast-1',
      'friend-1',
      KEY,
    );
    expect(response.status).toBe(200);
    expect(deliveryMocks.deliverTrackedLinePush).toHaveBeenCalledWith(expect.objectContaining({
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-1',
      friendId: 'friend-1',
      broadcastId: 'broadcast-1',
      content: expect.stringContaining('【テスト配信】'),
      source: 'broadcast',
      logDeliveryType: 'test',
      request: {
        to: 'U-one',
        messages: [expect.objectContaining({ type: 'text', text: expect.stringContaining('【テスト配信】') })],
      },
    }));
    expect(lineSdkMocks.pushMessage).toHaveBeenCalledWith(
      'U-one',
      [expect.objectContaining({ type: 'text', text: expect.stringContaining('【テスト配信】') })],
      operationId,
    );
  });
});

describe('GET /api/broadcasts/:id/per-account-stats tenant attribution', () => {
  test('requires tenant authority before reading message statistics', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'draft',
    });

    const response = await setupApp(db).request('/api/broadcasts/broadcast-1/per-account-stats');

    expect(response.status).toBe(404);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('hides statistics when any broadcast account is outside the tenant', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'draft',
    });
    boundaryMocks.accountOwned.mockResolvedValue(false);

    const response = await setupApp(db, 'tenant-a')
      .request('/api/broadcasts/broadcast-1/per-account-stats');

    expect(response.status).toBe(404);
    expect(boundaryMocks.accountOwned).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'account-1',
    );
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('never attributes legacy NULL logs to a friend current account', async () => {
    const sql: string[] = [];
    const db = {
      prepare: vi.fn((query: string) => {
        sql.push(query);
        return {
          bind: vi.fn(() => ({
            all: vi.fn().mockResolvedValue({ results: [] }),
          })),
        };
      }),
    } as unknown as D1Database;
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      id: 'broadcast-1',
      status: 'draft',
    });

    const response = await setupApp(db, 'tenant-a')
      .request('/api/broadcasts/broadcast-1/per-account-stats');

    const messagesQuery = sql.find((query) => query.includes('FROM messages_log')) ?? '';
    expect(response.status).toBe(200);
    expect(messagesQuery).toContain('ml.line_account_id IN')
    expect(messagesQuery).toContain("COALESCE(ml.delivery_type, '') != 'test'")
    expect(messagesQuery).not.toContain('COALESCE(ml.line_account_id')
    expect(messagesQuery).not.toContain('JOIN friends')
  });
});
