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

const broadcastRow = (lineAccountId: string) => ({
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
function db(ownedAccountIds: string[]) {
  return {
    prepare: (sql: string) => ({
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
    }),
  } as unknown as D1Database;
}

function app(tenantId: string, ownedAccountIds: string[]) {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
    await next();
  });
  root.route('/', broadcasts);
  return { root, env: { DB: db(ownedAccountIds) } as Env['Bindings'] };
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
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
});
