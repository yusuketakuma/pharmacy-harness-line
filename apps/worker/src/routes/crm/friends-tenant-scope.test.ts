import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  addTagToFriend: vi.fn(),
  tagBelongsToTenant: vi.fn(),
  getFriendById: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  getFriends: vi.fn(),
  getFriendById: mocks.getFriendById,
  getFriendCount: vi.fn(),
  addTagToFriend: mocks.addTagToFriend,
  tagBelongsToTenant: mocks.tagBelongsToTenant,
  removeTagFromFriend: vi.fn(),
  getFriendTags: vi.fn(),
  getFormSubmissionsByFriend: vi.fn(),
  getScenariosForAccount: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getMileageSummaryForFriend: vi.fn(),
  getMileageHistoryForFriend: vi.fn(),
  jstNow: vi.fn(() => '2026-08-18T12:00:00.000+09:00'),
}));
vi.mock('../../services/event-bus.js', () => ({ fireEvent: vi.fn() }));
vi.mock('../../services/step-delivery.js', () => ({ buildMessage: vi.fn() }));

import type { Env } from '../../index.js';
import { friends } from './friends.js';

type Query = { sql: string; params: unknown[] };

function setup() {
  const queries: Query[] = [];
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
          return { count: 0 };
        },
        async all() {
          queries.push({ sql, params: statement.params });
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  app.route('/', friends);
  return { app, env: { DB: db } as Env['Bindings'], queries };
}

describe('friend collection tenant scope', () => {
  it('constrains both list and total count to the authenticated tenant', async () => {
    const { app, env, queries } = setup();
    const response = await app.request('/api/friends?includeTags=false', {}, env);
    expect(response.status).toBe(200);
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const query of queries) {
      expect(query.sql).toContain('tenant_line_accounts');
      expect(query.params).toContain('tenant-a');
    }
  });

  it('constrains aggregate collection endpoints to the authenticated tenant', async () => {
    const { app, env, queries } = setup();
    const responses = await Promise.all([
      app.request('/api/friends/count', {}, env),
      app.request('/api/friends/ref-stats', {}, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const query of queries) {
      expect(query.sql).toContain('tenant_line_accounts');
      expect(query.params).toContain('tenant-a');
    }
  });
});

describe('friend route hardening (WP-09)', () => {
  it('rejects non-numeric limit with 400', async () => {
    const { app, env } = setup();
    const response = await app.request('/api/friends?limit=abc', {}, env);
    expect(response.status).toBe(400);
  });

  it('refuses to attach a tag owned by another tenant', async () => {
    const { app, env } = setup();
    mocks.getFriendById.mockResolvedValue({ id: 'friend-1', line_account_id: null });
    mocks.tagBelongsToTenant.mockResolvedValue(false);
    const response = await app.request('/api/friends/friend-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-of-tenant-b' }),
    }, env);
    expect(response.status).toBe(404);
    expect(mocks.tagBelongsToTenant).toHaveBeenCalledWith(expect.anything(), 'tag-of-tenant-b', 'tenant-a');
    expect(mocks.addTagToFriend).not.toHaveBeenCalled();
  });
});
