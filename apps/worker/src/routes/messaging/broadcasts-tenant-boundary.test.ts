import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { broadcasts } = await import('./broadcasts.js');

const broadcastRow = (lineAccountId: string | null) => ({
  id: 'broadcast-1',
  title: 'title',
  message_type: 'text',
  message_content: 'hello',
  target_type: 'all',
  target_tag_id: null,
  status: 'draft',
  scheduled_at: null,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-08-19T00:00:00.000+09:00',
  line_account_id: lineAccountId,
});

// tenant_line_accounts / pharmacy_staff_accounts mock matching the SQL shape
// used by accountResourceOwnedByStaff (apps/worker/src/middleware/
// tenant-boundary.ts): the account is pharmacy-mode, and ownership requires
// tenant membership AND an active pharmacy_staff_accounts assignment.
function db(ownedAccountIds: string[], sqlLog: string[] = []) {
  return {
    prepare: (sql: string) => {
      sqlLog.push(sql);
      return ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM pharmacy_account_capabilities')) return { mode: 'pharmacy' };
            if (sql.includes('FROM tenant_line_accounts AS mapping')) {
              const accountId = values.at(-1);
              return ownedAccountIds.includes(accountId as string) ? { ok: 1 } : null;
            }
            return null;
          },
        }),
      });
    },
  } as unknown as D1Database;
}

function app(tenantId: string, ownedAccountIds: string[], sqlLog?: string[]) {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
    await next();
  });
  root.route('/', broadcasts);
  return { root, env: { DB: db(ownedAccountIds, sqlLog) } as Env['Bindings'] };
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/broadcasts collection tenant boundary', () => {
  test('lists only owned broadcasts when a tenant session omits the account selector', async () => {
    dbMocks.getBroadcasts.mockResolvedValueOnce([
      broadcastRow('account-a'),
      { ...broadcastRow('account-b'), id: 'broadcast-b' },
      { ...broadcastRow(null), id: 'broadcast-global' },
    ]);
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts', {}, env);

    expect(response.status).toBe(200);
    expect((await response.json() as { data: Array<{ id: string }> }).data.map((item) => item.id))
      .toEqual(['broadcast-1']);
    expect(dbMocks.getBroadcasts).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  test('rejects a foreign account selector before listing broadcasts', async () => {
    dbMocks.getBroadcasts.mockResolvedValueOnce([]);
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts?lineAccountId=account-b', {}, env);

    expect(response.status).toBe(403);
    expect(dbMocks.getBroadcasts).not.toHaveBeenCalled();
  });

  test('does not list a mixed-account broadcast when the selected account is owned', async () => {
    dbMocks.getBroadcasts.mockResolvedValueOnce([{
      ...broadcastRow('account-a'),
      target_type: 'multi-account-dedup',
      account_ids: JSON.stringify(['account-a', 'account-b']),
    }]);
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts?lineAccountId=account-a', {}, env);

    expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe('GET /api/broadcasts/:id tenant boundary', () => {
  test('returns 404 for a broadcast whose account belongs to another tenant', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1', {}, env);

    expect(response.status).toBe(404);
  });

  test('returns the broadcast when the account belongs to the requesting tenant', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-a'));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1', {}, env);

    expect(response.status).toBe(200);
    expect((await response.json() as { data: { id: string } }).data.id).toBe('broadcast-1');
  });

  test('skips the ownership check when no tenant context is set', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const root = new Hono<Env>();
    root.route('/', broadcasts);
    const env = { DB: db([]) } as Env['Bindings'];

    const response = await root.request('/api/broadcasts/broadcast-1', {}, env);

    expect(response.status).toBe(200);
  });

  test('returns 404 for progress when the broadcast account belongs to another tenant', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1/progress', {}, env);

    expect(response.status).toBe(404);
  });

  test('returns 404 for a legacy unscoped broadcast in a tenant session', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow(null));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1', {}, env);

    expect(response.status).toBe(404);
  });

  test('returns 404 when any account in a multi-account broadcast is foreign', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({
      ...broadcastRow('account-a'),
      target_type: 'multi-account-dedup',
      account_ids: JSON.stringify(['account-a', 'account-b']),
    });
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1', {}, env);

    expect(response.status).toBe(404);
  });
});

describe('broadcast creation tenant boundary', () => {
  const body = {
    title: 'title',
    messageType: 'text',
    messageContent: 'hello',
    targetType: 'all',
  } as const;

  test('rejects a foreign lineAccountId before creating a broadcast', async () => {
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, lineAccountId: 'account-b' }),
    }, env);

    expect(response.status).toBe(403);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects an unscoped broadcast before creating it in a tenant session', async () => {
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env);

    expect(response.status).toBe(403);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects a multi-account broadcast when any target account is foreign', async () => {
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        targetType: 'multi-account-dedup',
        accountIds: ['account-a', 'account-b'],
        dedupPriority: ['account-a', 'account-b'],
      }),
    }, env);

    expect(response.status).toBe(403);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects a multi-account broadcast when its legacy lineAccountId is foreign', async () => {
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        targetType: 'multi-account-dedup',
        lineAccountId: 'account-b',
        accountIds: ['account-a'],
        dedupPriority: ['account-a'],
      }),
    }, env);

    expect(response.status).toBe(403);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });
});

describe('broadcast ID route tenant boundary', () => {
  test('rejects preview-count for a foreign broadcast before reading friends', async () => {
    const sql: string[] = [];
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a'], sql);

    const response = await root.request('/api/broadcasts/broadcast-1/preview-count', {}, env);

    expect(response.status).toBe(404);
    expect(sql.some((query) => query.includes('FROM friends'))).toBe(false);
  });

  test('rejects update for a foreign broadcast before updating or resetting it', async () => {
    const sql: string[] = [];
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a'], sql);

    const response = await root.request('/api/broadcasts/broadcast-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'changed' }),
    }, env);

    expect(response.status).toBe(404);
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
    expect(sql.some((query) => query.includes('UPDATE broadcasts'))).toBe(false);
  });

  test('rejects delete for an unscoped broadcast before deleting it', async () => {
    const sql: string[] = [];
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow(null));
    const { root, env } = app('tenant-a', ['account-a'], sql);

    const response = await root.request('/api/broadcasts/broadcast-1', { method: 'DELETE' }, env);

    expect(response.status).toBe(404);
    expect(dbMocks.deleteBroadcast).not.toHaveBeenCalled();
    expect(sql.some((query) => query.includes('DELETE FROM broadcasts'))).toBe(false);
  });

  test('rejects insight reads for a foreign broadcast before reading insight rows', async () => {
    const sql: string[] = [];
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a'], sql);

    const response = await root.request('/api/broadcasts/broadcast-1/insight', {}, env);

    expect(response.status).toBe(404);
    expect(sql.some((query) => query.includes('broadcast_insights'))).toBe(false);
  });

  test('rejects fetch-insight for a foreign broadcast before D1 or provider work', async () => {
    const sql: string[] = [];
    dbMocks.getBroadcastById.mockResolvedValueOnce({
      ...broadcastRow('account-b'),
      status: 'sent',
      sent_at: '2026-08-31T00:00:00.000+09:00',
    });
    const { root, env } = app('tenant-a', ['account-a'], sql);

    const response = await root.request('/api/broadcasts/broadcast-1/fetch-insight', { method: 'POST' }, env);

    expect(response.status).toBe(404);
    expect(sql.some((query) => query.includes('FROM broadcasts'))).toBe(false);
    expect(sql.some((query) => query.includes('broadcast_insights'))).toBe(false);
  });
});

describe('broadcast target type safety', () => {
  test('rejects segment targets before creating a broadcast', async () => {
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'segment broadcast',
        messageType: 'text',
        messageContent: 'hello',
        targetType: 'segment',
      }),
    }, env);

    expect(response.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects changing a broadcast target to segment before updating it', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-a'));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'segment' }),
    }, env);

    expect(response.status).toBe(400);
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
  });

  test('rejects sending a persisted segment target before queue or LINE mutation', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({
      ...broadcastRow('account-a'),
      target_type: 'segment',
    });
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1/send', {
      method: 'POST',
    }, env);

    expect(response.status).toBe(400);
  });
});

describe('broadcast send tenant boundary', () => {
  test('rejects sending a broadcast owned by another tenant before LINE or queue mutation', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1/send', {
      method: 'POST',
    }, env);

    expect(response.status).toBe(404);
  });

  test('rejects segment sending for a broadcast owned by another tenant', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(broadcastRow('account-b'));
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1/send-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions: { operator: 'AND', rules: [] } }),
    }, env);

    expect(response.status).toBe(404);
  });

  test('rejects a multi-account send when any target account is outside the tenant', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({
      ...broadcastRow('account-a'),
      target_type: 'multi-account-dedup',
      account_ids: JSON.stringify(['account-a', 'account-b']),
      dedup_priority: JSON.stringify([]),
    });
    const { root, env } = app('tenant-a', ['account-a']);

    const response = await root.request('/api/broadcasts/broadcast-1/send', {
      method: 'POST',
    }, env);

    expect(response.status).toBe(404);
  });
});
