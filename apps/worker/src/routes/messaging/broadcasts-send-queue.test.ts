import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  getBroadcastById: vi.fn(),
  getLineAccountById: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {},
}));

const boundaryMocks = vi.hoisted(() => ({ accountOwned: vi.fn() }));
vi.mock('../../middleware/tenant-boundary.js', () => ({
  accountResourceOwnedByStaff: boundaryMocks.accountOwned,
}));

const serviceMocks = vi.hoisted(() => ({
  processBroadcastSend: vi.fn(),
  processQueuedBroadcasts: vi.fn(),
}));
vi.mock('../../services/broadcast.js', () => ({
  buildMessage: vi.fn(),
  processBroadcastSend: serviceMocks.processBroadcastSend,
  processQueuedBroadcasts: serviceMocks.processQueuedBroadcasts,
}));

const { broadcasts } = await import('./broadcasts.js');

const row = {
  id: 'broadcast-a',
  title: 'A',
  message_type: 'text',
  message_content: 'hello',
  target_type: 'all',
  target_tag_id: null,
  status: 'draft',
  scheduled_at: null,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-08-31T00:00:00.000Z',
  line_account_id: 'account-a',
  account_ids: null,
  dedup_priority: null,
  failed_account_ids: null,
  track_links: 0,
};

describe('POST /api/broadcasts/:id/send queued delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getBroadcastById.mockResolvedValue(row);
    dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'token-a' });
    boundaryMocks.accountOwned.mockResolvedValue(true);
    serviceMocks.processBroadcastSend.mockResolvedValue({ ...row, status: 'sending' });
    serviceMocks.processQueuedBroadcasts.mockResolvedValue(undefined);
  });

  it('returns 202 and starts the queue when processing only enqueues', async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) })),
    }));
    const app = new Hono<{ Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string } }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, 'tenant-a' as never);
      await next();
    });
    app.route('/', broadcasts);
    const waitUntil = vi.fn();

    const response = await app.request(
      '/api/broadcasts/broadcast-a/send',
      { method: 'POST' },
      { DB: { prepare } as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: 'default-token' },
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(serviceMocks.processQueuedBroadcasts).toHaveBeenCalledOnce();
  });
});

describe('POST /api/broadcasts/:id/send-segment target persistence', () => {
  it('persists segment target type before queueing even when the draft was all-targeted', async () => {
    const conditions = { operator: 'AND', rules: [{ type: 'is_following', value: true }] };
    let lockSql = '';
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => {
        lockSql = sql;
        return { run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) };
      }),
    }));
    dbMocks.getBroadcastById
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({
        ...row,
        target_type: 'segment',
        segment_conditions: JSON.stringify(conditions),
        batch_offset: 0,
      });
    const app = new Hono<{ Bindings: { DB: D1Database } }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, 'tenant-a' as never);
      await next();
    });
    app.route('/', broadcasts);

    const response = await app.request(
      '/api/broadcasts/broadcast-a/send-segment',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions }),
      },
      { DB: { prepare } as unknown as D1Database },
    );

    expect(response.status).toBe(202);
    expect(lockSql).toContain("target_type = 'segment'");
    expect(lockSql).toContain('batch_offset = 0');
    expect(lockSql).toContain('segment_conditions = ?');
    expect((await response.json() as { data: { targetType: string } }).data.targetType).toBe('segment');
  });
});

describe('GET /api/broadcasts/:id/progress reconciliation', () => {
  it('returns failed account ids for operator-visible reconciliation', async () => {
    dbMocks.getBroadcastById.mockResolvedValue({
      ...row,
      status: 'sending',
      failed_account_ids: JSON.stringify(['account-a']),
    });
    const app = new Hono<{ Bindings: { DB: D1Database } }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, 'tenant-a' as never);
      await next();
    });
    app.route('/', broadcasts);

    const response = await app.request(
      '/api/broadcasts/broadcast-a/progress',
      {},
      { DB: {} as D1Database },
    );

    expect(response.status).toBe(200);
    expect((await response.json() as { data: { failedAccountIds: string[] } }).data.failedAccountIds)
      .toEqual(['account-a']);
  });
});
