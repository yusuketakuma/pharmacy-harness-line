import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';

const dbMocks = vi.hoisted(() => ({
  getAutoReplies: vi.fn(),
  getAutoReplyById: vi.fn(),
  createAutoReply: vi.fn(),
  updateAutoReply: vi.fn(),
  deleteAutoReply: vi.fn(),
  getTemplateById: vi.fn(),
}));
vi.mock('@line-crm/db', () => dbMocks);

const boundaryMocks = vi.hoisted(() => ({
  accountResourceOwnedByStaff: vi.fn(),
}));
vi.mock('../../middleware/tenant-boundary.js', () => boundaryMocks);

const { autoReplies } = await import('./auto-replies.js');

interface AutoReplyRow {
  id: string;
  keyword: string;
  match_type: 'exact' | 'contains';
  response_type: string;
  response_content: string;
  template_id: string | null;
  line_account_id: string | null;
  is_active: number;
  created_at: string;
}

function autoReply(id: string, lineAccountId: string | null): AutoReplyRow {
  return {
    id,
    keyword: id,
    match_type: 'exact',
    response_type: 'text',
    response_content: 'response',
    template_id: null,
    line_account_id: lineAccountId,
    is_active: 1,
    created_at: '2026-08-31T00:00:00.000+09:00',
  };
}

function routeDb(
  accounts: Array<{ id: string; name: string }>,
  automations: Array<{ line_account_id: string; conditions: string; actions: string }>,
) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          binds = next;
          return statement;
        },
        async all<T>() {
          calls.push({ sql, binds });
          if (/FROM line_accounts\b/i.test(sql)) {
            const results = binds.includes('tenant-a')
              ? accounts.filter((account) => account.id === 'account-a')
              : accounts;
            return { results } as { results: T[] };
          }
          if (/FROM automations\b/i.test(sql)) {
            const results = binds.includes('tenant-a')
              ? automations.filter((automation) => automation.line_account_id === 'account-a')
              : automations;
            return { results } as { results: T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          calls.push({ sql, binds });
          return null as T | null;
        },
        async run() {
          calls.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(
  db: D1Database,
  options: { tenantId?: string; staffId?: string } = {},
) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (options.tenantId !== undefined) c.set('tenantId', options.tenantId);
    if (options.staffId !== undefined) {
      c.set('staff', { id: options.staffId, name: 'Staff', role: 'staff' });
    }
    await next();
  });
  app.route('/', autoReplies);
  return { app, env: { DB: db } as Env['Bindings'] };
}

beforeEach(() => {
  for (const mock of Object.values(dbMocks)) mock.mockReset();
  boundaryMocks.accountResourceOwnedByStaff.mockReset();
});

describe('auto-reply tenant boundary', () => {
  it('lists only mapped account rows and scopes effective accounts and automation index', async () => {
    const rows = [autoReply('reply-a', 'account-a'), autoReply('reply-b', 'account-b'), autoReply('reply-global', null)];
    dbMocks.getAutoReplies.mockImplementation(
      async (_db: D1Database, accountId?: string, tenantId?: string) => {
        const scoped = tenantId === undefined
          ? rows
          : rows.filter((row) => row.line_account_id === 'account-a');
        return accountId
          ? scoped.filter((row) => row.line_account_id === accountId)
          : scoped;
      },
    );
    const { db, calls } = routeDb(
      [{ id: 'account-a', name: 'Account A' }, { id: 'account-b', name: 'Account B' }],
      [
        { line_account_id: 'account-a', conditions: JSON.stringify({ keyword: 'reply-a' }), actions: JSON.stringify([{ type: 'send_message' }]) },
        { line_account_id: 'account-b', conditions: JSON.stringify({ keyword: 'reply-b' }), actions: JSON.stringify([{ type: 'send_message' }]) },
      ],
    );
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await app.request('/api/auto-replies', {}, env);
    const body = await response.json() as { data: Array<{ id: string; effectiveAccounts?: Array<{ accountId: string }> }> };

    expect(response.status).toBe(200);
    expect(body.data.map((row) => row.id)).toEqual(['reply-a']);
    expect(body.data[0]?.effectiveAccounts?.map((account) => account.accountId)).toEqual(['account-a']);
    expect(dbMocks.getAutoReplies).toHaveBeenCalledWith(db, undefined, 'tenant-a');

    const accountQuery = calls.find((call) => /FROM line_accounts\b/i.test(call.sql));
    expect(accountQuery?.sql).toMatch(/tenant_line_accounts/i);
    expect(accountQuery?.binds).toEqual(['tenant-a']);
    const automationQuery = calls.find((call) => /FROM automations\b/i.test(call.sql));
    expect(automationQuery?.sql).toMatch(/tenant_line_accounts/i);
    expect(automationQuery?.binds).toEqual(['tenant-a']);
  });

  it('rejects a foreign account selector before reading rows', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await app.request('/api/auto-replies?accountId=account-b', {}, env);

    expect(response.status).toBe(403);
    expect(dbMocks.getAutoReplies).not.toHaveBeenCalled();
  });

  it.each([
    ['foreign account', autoReply('reply-b', 'account-b')],
    ['legacy NULL row', autoReply('reply-global', null)],
  ])('does not expose a %s in tenant detail', async (_label, row) => {
    dbMocks.getAutoReplyById.mockImplementation(
      async (_db: D1Database, _id: string, tenantId?: string) => tenantId === undefined ? row : null,
    );
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await app.request(`/api/auto-replies/${row.id}`, {}, env);

    expect(response.status).toBe(404);
  });

  it('rejects foreign update and delete before mutation', async () => {
    const foreign = autoReply('reply-b', 'account-b');
    dbMocks.getAutoReplyById.mockImplementation(
      async (_db: D1Database, _id: string, tenantId?: string) => tenantId === undefined ? foreign : null,
    );
    dbMocks.updateAutoReply.mockResolvedValue(foreign);
    dbMocks.deleteAutoReply.mockResolvedValue(true);
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const update = await app.request(`/api/auto-replies/${foreign.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'spoofed', tenantId: 'tenant-b', lineAccountId: 'account-b' }),
    }, env);
    const remove = await app.request(`/api/auto-replies/${foreign.id}`, { method: 'DELETE' }, env);

    expect(update.status).toBe(404);
    expect(remove.status).toBe(404);
    expect(dbMocks.updateAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutoReply).not.toHaveBeenCalled();
  });

  it('requires an owned non-null account for tenant create', async () => {
    dbMocks.createAutoReply.mockResolvedValue(autoReply('reply-a', 'account-a'));
    const { db } = routeDb([], []);
    const scoped = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const missing = await scoped.app.request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'missing', responseType: 'text', responseContent: 'reply' }),
    }, scoped.env);
    expect(missing.status).toBe(400);
    expect(dbMocks.createAutoReply).not.toHaveBeenCalled();

    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(false);
    const foreign = await scoped.app.request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'foreign', responseType: 'text', responseContent: 'reply', lineAccountId: 'account-b', tenantId: 'tenant-b' }),
    }, scoped.env);
    expect(foreign.status).toBe(403);
    expect(dbMocks.createAutoReply).not.toHaveBeenCalled();
  });

  it('passes the server tenant to an owned create and ignores a body tenant selector', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.createAutoReply.mockResolvedValue(autoReply('reply-a', 'account-a'));
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await app.request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: 'owned',
        responseType: 'text',
        responseContent: 'reply',
        lineAccountId: 'account-a',
        tenantId: 'tenant-b',
      }),
    }, env);

    expect(response.status).toBe(201);
    expect(dbMocks.createAutoReply).toHaveBeenCalledWith(db, expect.objectContaining({
      keyword: 'owned',
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
    }));
  });

  it('resolves a referenced template only inside the server tenant', async () => {
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.getTemplateById.mockResolvedValue({
      id: 'template-a',
      message_type: 'text',
      message_content: 'template response',
    });
    dbMocks.createAutoReply.mockResolvedValue(autoReply('reply-a', 'account-a'));
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await app.request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: 'owned',
        templateId: 'template-a',
        lineAccountId: 'account-a',
      }),
    }, env);

    expect(response.status).toBe(201);
    expect(dbMocks.getTemplateById).toHaveBeenCalledWith(db, 'template-a', 'tenant-a');
  });

  it('rejects a template reference outside the server tenant before mutation', async () => {
    const owned = autoReply('reply-a', 'account-a');
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    dbMocks.getAutoReplyById.mockResolvedValue(owned);
    dbMocks.getTemplateById.mockResolvedValue(null);
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const create = await app.request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: 'foreign',
        templateId: 'template-b',
        lineAccountId: 'account-a',
      }),
    }, env);
    const update = await app.request(`/api/auto-replies/${owned.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'template-b' }),
    }, env);

    expect([create.status, update.status]).toEqual([400, 400]);
    expect(dbMocks.createAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.updateAutoReply).not.toHaveBeenCalled();
  });

  it('does not let a tenant update change the account selector', async () => {
    const owned = autoReply('reply-a', 'account-a');
    dbMocks.getAutoReplyById.mockResolvedValue(owned);
    dbMocks.updateAutoReply.mockResolvedValue(owned);
    boundaryMocks.accountResourceOwnedByStaff.mockResolvedValue(true);
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db, { tenantId: 'tenant-a', staffId: 'staff-a' });

    const response = await app.request(`/api/auto-replies/${owned.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'updated', lineAccountId: 'account-b', tenantId: 'tenant-b' }),
    }, env);

    expect(response.status).toBe(200);
    expect(dbMocks.updateAutoReply).toHaveBeenCalledWith(
      db,
      owned.id,
      { keyword: 'updated' },
      'tenant-a',
    );
  });

  it('keeps legacy OSS behavior when no tenant context exists', async () => {
    const global = autoReply('reply-global', null);
    const account = autoReply('reply-a', 'account-a');
    dbMocks.getAutoReplies.mockResolvedValue([global, account]);
    dbMocks.getAutoReplyById.mockResolvedValue(global);
    const { db } = routeDb([], []);
    const { app, env } = setupApp(db);

    const list = await app.request('/api/auto-replies', {}, env);
    const detail = await app.request(`/api/auto-replies/${global.id}`, {}, env);

    expect(list.status).toBe(200);
    expect((await list.clone().json() as { data: Array<{ id: string }> }).data.map((row) => row.id))
      .toEqual(['reply-global', 'reply-a']);
    expect(detail.status).toBe(200);
  });
});
