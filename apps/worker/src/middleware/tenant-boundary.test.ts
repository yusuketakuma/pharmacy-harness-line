import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { Env } from '../index.js';
import {
  tenantAccountSelectorGuard,
  tenantFriendResourceGuard,
  tenantRichMenuResourceGuard,
  tenantScenarioResourceGuard,
} from './tenant-boundary.js';

function app(ownedAccountIds: string[]) {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  root.use('*', tenantAccountSelectorGuard);
  root.all('*', (c) => c.json({ ok: true }));
  const db = {
    prepare: (sql: string) => ({
      bind: (_tenantId: string, accountId: string) => ({
        first: async () => sql.includes('sqlite_master')
          ? null
          : ownedAccountIds.includes(accountId) ? { ok: 1 } : null,
      }),
    }),
  } as unknown as D1Database;
  return { root, env: { DB: db } as Env['Bindings'] };
}

describe('tenant account selector guard', () => {
  it('rejects a query-selected LINE account outside the authenticated tenant', async () => {
    const { root, env } = app(['account-a']);
    const response = await root.request('/api/chats?lineAccountId=account-b', {}, env);
    expect(response.status).toBe(403);
  });

  it('rejects a body-selected LINE account outside the authenticated tenant', async () => {
    const { root, env } = app(['account-a']);
    const response = await root.request('/api/example', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds: ['account-a', 'account-b'] }),
    }, env);
    expect(response.status).toBe(403);
  });

  it('rejects a JSON body even when a client lies about Content-Type', async () => {
    const { root, env } = app(['account-a']);
    const response = await root.request('/api/example', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ accountId: 'account-b' }),
    }, env);
    expect(response.status).toBe(403);
  });

  it('allows selectors wholly owned by the authenticated tenant', async () => {
    const { root, env } = app(['account-a']);
    const response = await root.request('/api/chats?lineAccountId=account-a', {}, env);
    expect(response.status).toBe(200);
  });

  it('allows a platform admin only for accounts mapped to the selected tenant', async () => {
    const root = new Hono<Env>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      c.set('staff', { id: 'platform-admin-1', name: 'Platform Owner', role: 'owner' });
      c.set('platformAdmin', { id: 'platform-admin-1', name: 'Platform Owner' });
      await next();
    });
    root.use('*', tenantAccountSelectorGuard);
    root.all('*', (c) => c.json({ ok: true }));
    const db = {
      prepare: () => ({
        bind: (tenantId: string, accountId: string) => ({
          first: async () => tenantId === 'tenant-a' && accountId === 'account-a' ? { ok: 1 } : null,
        }),
      }),
    } as unknown as D1Database;
    const env = { DB: db } as Env['Bindings'];

    expect((await root.request('/api/rich-menu-groups?accountId=account-a', {}, env)).status).toBe(200);
    expect((await root.request('/api/rich-menu-groups?accountId=account-b', {}, env)).status).toBe(403);
  });

  it('rejects an unassigned pharmacy account even inside the same tenant', async () => {
    const root = new Hono<Env>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
      await next();
    });
    root.use('*', tenantAccountSelectorGuard);
    root.all('*', (c) => c.json({ ok: true }));
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: string[]) => ({
          first: async () => {
            if (sql.includes('pharmacy_account_capabilities')) return { mode: 'pharmacy' };
            if (sql.includes('pharmacy_staff_accounts')) return null;
            return values.includes('account-a') ? { ok: 1 } : null;
          },
        }),
      }),
    } as unknown as D1Database;
    const response = await root.request('/api/chats?lineAccountId=account-a', {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(403);
  });

  it('fails closed when the pharmacy capability row is missing after the table is deployed', async () => {
    const root = new Hono<Env>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
      await next();
    });
    root.use('*', tenantAccountSelectorGuard);
    root.all('*', (c) => c.json({ ok: true }));
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: string[]) => ({
          first: async () => {
            if (sql.includes('sqlite_master')) return { name: 'pharmacy_account_capabilities' };
            if (sql.includes('pharmacy_account_capabilities')) return null;
            if (sql.includes('pharmacy_staff_accounts')) return null;
            return values.includes('account-a') ? { ok: 1 } : null;
          },
        }),
      }),
    } as unknown as D1Database;
    const response = await root.request('/api/chats?lineAccountId=account-a', {}, { DB: db } as Env['Bindings']);
    expect(response.status).toBe(403);
  });
});

function resourceApp(ownedFriendIds: string[], ownedChatIds: string[] = []) {
  const root = new Hono<Env>();
  root.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  root.use('*', tenantFriendResourceGuard);
  root.all('*', (c) => c.json({ ok: true }));
  const db = {
    prepare: (sql: string) => ({
        bind: (_tenantId: string, resourceId: string) => ({
          first: async () => {
          if (sql.includes('SELECT friend.line_account_id')) {
            return ownedFriendIds.includes(resourceId) || ownedChatIds.includes(resourceId)
              ? { line_account_id: 'account-a' }
              : null;
          }
            if (sql.includes('pharmacy_account_capabilities')) return null;
            if (sql.includes('sqlite_master')) return null;
          if (sql.includes('FROM tenant_line_accounts AS mapping') && sql.includes('line_accounts AS account')) {
            return { ok: 1 };
          }
          const owned = sql.includes('chat.id')
            ? ownedFriendIds.includes(resourceId) || ownedChatIds.includes(resourceId)
            : ownedFriendIds.includes(resourceId);
          return owned ? { ok: 1 } : null;
        },
      }),
    }),
  } as unknown as D1Database;
  return { root, env: { DB: db } as Env['Bindings'] };
}

describe('tenant friend resource guard', () => {
  it('matches a percent-encoded friend id against the decoded route param', async () => {
    const { root, env } = resourceApp(['friend a']);
    expect((await root.request('/api/friends/friend%20a', {}, env)).status).toBe(200);
    expect((await root.request('/api/friends/friend%20b', {}, env)).status).toBe(403);
  });

  it('rejects friend and chat ids outside the authenticated tenant', async () => {
    const { root, env } = resourceApp(['friend-a'], ['chat-a']);
    const responses = await Promise.all([
      root.request('/api/friends/friend-b/messages', {}, env),
      root.request('/api/chats/chat-b/send', { method: 'POST' }, env),
      root.request('/api/conversations/friend-b', {}, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
  });

  it('checks a newly created chat friend from the JSON body', async () => {
    const { root, env } = resourceApp(['friend-a']);
    const response = await root.request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-b' }),
    }, env);
    expect(response.status).toBe(403);
  });

  it('rejects a friend body even when a client lies about Content-Type', async () => {
    const { root, env } = resourceApp(['friend-a']);
    const response = await root.request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ friendId: 'friend-b' }),
    }, env);
    expect(response.status).toBe(403);
  });

  it('rejects any foreign friend in a JSON friend-id collection', async () => {
    const { root, env } = resourceApp(['friend-a']);
    const response = await root.request('/api/account-settings/test-recipients', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendIds: ['friend-a', 'friend-b'] }),
    }, env);
    expect(response.status).toBe(403);
  });

  it('allows tenant-owned resources and collection endpoints', async () => {
    const { root, env } = resourceApp(['friend-a'], ['chat-a']);
    const responses = await Promise.all([
      root.request('/api/friends/friend-a', {}, env),
      root.request('/api/chats/chat-a', {}, env),
      root.request('/api/friends/count', {}, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it('authorizes the friend id in a manual scenario enrollment path', async () => {
    const { root, env } = resourceApp(['friend-a']);
    const responses = await Promise.all([
      root.request('/api/scenarios/scenario-a/enroll/friend-a', { method: 'POST' }, env),
      root.request('/api/scenarios/scenario-a/enroll/friend-b', { method: 'POST' }, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 403]);
  });
});

describe('tenant scenario resource guard', () => {
  it('rejects foreign, missing, and unassigned account-bound scenarios on every child route', async () => {
    const root = new Hono<Env>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    root.use('*', tenantScenarioResourceGuard);
    root.all('*', (c) => c.json({ ok: true }));
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: string[]) => ({
          first: async () => {
            if (sql.includes('FROM scenarios AS scenario')) {
              const [scenarioId, tenantId] = values;
              if (tenantId !== 'tenant-a') return null;
              if (scenarioId === 'scenario-global') return { line_account_id: null };
              if (scenarioId === 'scenario-owned') return { line_account_id: 'account-a' };
              if (scenarioId === 'scenario-unassigned') return { line_account_id: 'account-b' };
              return null;
            }
            if (sql.includes('pharmacy_account_capabilities')) return null;
            if (sql.includes('sqlite_master')) return null;
            return values.at(-1) === 'account-a' ? { ok: 1 } : null;
          },
        }),
      }),
    } as unknown as D1Database;
    const env = { DB: db } as Env['Bindings'];

    const responses = await Promise.all([
      root.request('/api/scenarios/scenario-global', {}, env),
      root.request('/api/scenarios/scenario-owned/steps/step-a', { method: 'PUT' }, env),
      root.request('/api/scenarios/scenario-foreign/stats', {}, env),
      root.request('/api/scenarios/scenario-unassigned/preview', {}, env),
      root.request('/api/scenarios', {}, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 403, 403, 200]);
  });
});

describe('tenant rich-menu resource guard', () => {
  it('rejects foreign groups and account-prefixed R2 images', async () => {
    const root = new Hono<Env>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
      await next();
    });
    root.use('*', tenantRichMenuResourceGuard);
    root.all('*', (c) => c.json({ ok: true }));
    const db = {
      prepare(sql: string) {
        return {
          bind: (...values: string[]) => ({
            first: async () => {
              if (sql.includes('FROM rich_menu_groups')) {
                return values[0] === 'group-a' ? { account_id: 'account-a' } : null;
              }
              if (sql.includes('pharmacy_account_capabilities')) return null;
              if (sql.includes('sqlite_master')) return null;
              if (sql.includes('pharmacy_staff_accounts')) {
                return values.at(-1) === 'account-a' ? { ok: 1 } : null;
              }
              if (sql.includes('line_accounts AS account')) {
                return values.at(-1) === 'account-a' ? { ok: 1 } : null;
              }
              if (sql.includes('FROM tenant_line_accounts AS mapping')) {
                return ['account-a', 'account-b'].includes(values[0] ?? '') ? { ok: 1 } : null;
              }
              const id = values.at(-1);
              const owned = id === 'account-a';
              return owned ? { ok: 1 } : null;
            },
          }),
        };
      },
    } as unknown as D1Database;
    const env = { DB: db } as Env['Bindings'];

    const responses = await Promise.all([
      root.request('/api/rich-menu-groups/group-b/publish', { method: 'POST' }, env),
      root.request('/api/rich-menu-images/rich-menus/account-b/group/page/image.png', {}, env),
      root.request('/api/rich-menu-images/prescriptions/account-a/private.png', {}, env),
      root.request('/api/rich-menu-groups/group-a', {}, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 200]);
  });
});
