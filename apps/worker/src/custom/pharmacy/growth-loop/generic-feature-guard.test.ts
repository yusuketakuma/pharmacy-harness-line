import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PHARMACY_DISABLED_GENERIC_API_PREFIXES,
  pharmacyGenericFeatureGuard,
  pharmacyManualChatMutationGuard,
  pharmacyTenantApiAllowlistGuard,
} from './generic-feature-guard.js';

function db(pharmacyAccounts: string[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = (binds: unknown[]) => ({
        first: async <T>() => {
          if (sql.includes('FROM tenant_line_accounts') && !sql.includes('WHERE tenant_id')) {
            return (pharmacyAccounts.length > 0 ? { ok: 1 } : null) as T | null;
          }
          if (sql.includes('FROM tenant_line_accounts') && sql.includes('WHERE tenant_id')) {
            return (pharmacyAccounts.length > 0 ? { ok: 1 } : null) as T | null;
          }
          if (sql.includes('FROM pharmacy_account_capabilities')) {
            if (sql.includes("WHERE mode = 'pharmacy'") ||
                (sql.includes('WHERE mode = ?') && binds[0] === 'pharmacy')) {
              return (pharmacyAccounts.length > 0 ? { ok: 1 } : null) as T | null;
            }
            return (pharmacyAccounts.includes(String(binds[0])) ? { mode: 'pharmacy' } : null) as T | null;
          }
          if (sql.includes('FROM broadcasts')) {
            return { line_account_id: 'pharmacy-a', account_ids: null, target_tag_id: null } as T;
          }
          if (sql.includes('FROM line_accounts') && (sql.includes('channel_id') || sql.includes('liff_id'))) {
            return { id: 'pharmacy-a' } as T;
          }
          return null;
        },
        all: async <T>() => ({ results: [] as T[] }),
      });
      return {
        bind: (...binds: unknown[]) => statement(binds),
        ...statement([]),
      };
    },
  } as unknown as D1Database;
}

function app(database: D1Database) {
  const root = new Hono<{ Bindings: { DB: D1Database; LINE_CHANNEL_ID: string } }>();
  root.use('*', pharmacyGenericFeatureGuard);
  root.all('*', async (c) => {
    const body = c.req.method === 'POST' ? await c.req.json() : null;
    return c.json({ ok: true, body });
  });
  return { root, env: { DB: database, LINE_CHANNEL_ID: 'default-channel' } };
}

describe('pharmacy generic feature guard', () => {
  it('keeps high-risk generic API families behind the installed contract guard', () => {
    expect(PHARMACY_DISABLED_GENERIC_API_PREFIXES).toEqual(expect.arrayContaining([
      '/api/broadcasts', '/api/scenarios', '/api/automations', '/api/auto-replies',
      '/api/reminders', '/api/mileage', '/api/affiliates', '/api/traffic-pools', '/api/webinars',
      '/api/forms', '/api/meet-callback', '/api/booking', '/api/liff/booking',
      '/api/events', '/api/liff/events', '/api/liff/send-form-link', '/api/tags', '/api/operators',
      '/api/rich-menus', '/api/liff/affiliate', '/api/liff/mileage', '/api/liff/link',
      '/api/webhooks', '/api/integrations/stripe', '/api/qr', '/api/public/media-inquiries',
    ]));
    const indexSource = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url).href), 'utf8');
    expect(indexSource).toContain('PHARMACY_DISABLED_GENERIC_API_PREFIXES');
    expect(indexSource).toContain('pharmacyGenericFeatureGuard');
  });

  it('denies an explicitly scoped generic API for a pharmacy account', async () => {
    const { root, env } = app(db(['pharmacy-a']));
    const response = await root.request('/api/broadcasts?lineAccountId=pharmacy-a', {}, env);
    expect(response.status).toBe(403);
  });

  it('resolves a generic resource account on the server before denying it', async () => {
    const { root, env } = app(db(['pharmacy-a']));
    const response = await root.request('/api/broadcasts/broadcast-1/send', { method: 'POST' }, env);
    expect(response.status).toBe(403);
  });

  it('uses the configured default account for an unscoped mutation', async () => {
    const { root, env } = app(db(['pharmacy-a']));
    const response = await root.request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'generic automation' }),
    }, env);
    expect(response.status).toBe(403);
  });

  it('uses the configured default account for an unscoped read', async () => {
    const { root, env } = app(db(['pharmacy-a']));
    const response = await root.request('/api/broadcasts', {}, env);
    expect(response.status).toBe(403);
  });

  it('allows only the tenant-scoped tag read needed by the pharmacy friend filter', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM line_accounts') && sql.includes('channel_id')) {
              return { id: 'generic-default' } as T;
            }
            if (sql.includes('FROM pharmacy_account_capabilities')) {
              return (binds[0] === 'pharmacy-a' ? { mode: 'pharmacy' } : null) as T | null;
            }
            return null;
          },
          all: async <T>() => ({
            results: (sql.includes('FROM tenant_line_accounts')
              ? [{ line_account_id: 'pharmacy-a' }]
              : []) as T[],
          }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const root = new Hono<any>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    root.use('*', pharmacyGenericFeatureGuard);
    root.all('*', (c) => c.json({ ok: true }));

    const [readResponse, writeResponse] = await Promise.all([
      root.request('/api/tags', {}, { DB: database, LINE_CHANNEL_ID: 'generic-default-channel' }),
      root.request('/api/tags', { method: 'POST' }, { DB: database, LINE_CHANNEL_ID: 'generic-default-channel' }),
    ]);

    expect(readResponse.status).toBe(200);
    expect(writeResponse.status).toBe(403);
  });

  it('fails closed when an unscoped request cannot resolve the default in a pharmacy install', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes("WHERE mode = 'pharmacy'") ||
                (sql.includes('WHERE mode = ?') && binds[0] === 'pharmacy')) return { ok: 1 } as T;
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const response = await root.request('/api/automations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, env);

    expect(response.status).toBe(403);
  });

  it('fails closed for global public CRM APIs in a mixed pharmacy install', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM line_accounts') && sql.includes('channel_id')) {
              return { id: 'generic-default' } as T;
            }
            if (sql.includes("WHERE mode = 'pharmacy'") ||
                (sql.includes('WHERE mode = ?') && binds[0] === 'pharmacy')) return { ok: 1 } as T;
            if (sql.includes('FROM pharmacy_account_capabilities')) return null;
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const responses = await Promise.all([
      root.request('/api/qr?data=hello', {}, env),
      root.request('/api/webhooks/incoming/webhook-a/receive', { method: 'POST' }, env),
      root.request('/api/integrations/stripe/webhook', { method: 'POST' }, env),
      root.request('/api/public/media-inquiries', { method: 'POST' }, env),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 403]);
  });

  it('server-resolves other high-risk generic resources', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM auto_replies')) return { line_account_id: 'pharmacy-a' } as T;
            if (sql.includes('FROM webinars')) return { line_account_id: 'pharmacy-a' } as T;
            if (sql.includes('FROM traffic_pools')) return { line_account_id: 'pharmacy-a' } as T;
            if (sql.includes('FROM friends')) return { line_account_id: 'pharmacy-a' } as T;
            if (sql.includes('FROM line_accounts')) return { id: 'generic-a' } as T;
            if (sql.includes('FROM pharmacy_account_capabilities')) {
              return (binds[0] === 'pharmacy-a' ? { mode: 'pharmacy' } : null) as T | null;
            }
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const responses = await Promise.all([
      root.request('/api/auto-replies/reply-1', { method: 'PUT' }, env),
      root.request('/api/reminders/reminder-1/enroll/friend-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }, env),
      root.request('/api/liff/webinars/pharmacy-webinar/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }, env),
      root.request('/api/traffic-pools/pool-1', { method: 'PUT' }, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
  });

  it('denies enrolling a pharmacy friend into a global generic scenario', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM scenarios')) return { line_account_id: null } as T;
            if (sql.includes('FROM friends')) return { line_account_id: 'pharmacy-a' } as T;
            if (sql.includes('FROM line_accounts')) return { id: 'generic-a' } as T;
            if (sql.includes('FROM pharmacy_account_capabilities')) {
              return (binds[0] === 'pharmacy-a' ? { mode: 'pharmacy' } : null) as T | null;
            }
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const response = await root.request(
      '/api/scenarios/scenario-global/enroll/friend-pharmacy',
      { method: 'POST' },
      env,
    );

    expect(response.status).toBe(403);
  });

  it('denies a generic callback when its LINE user resolves to a pharmacy account', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM friends') && sql.includes('line_user_id')) {
              return { line_account_id: 'pharmacy-a' } as T;
            }
            if (sql.includes('FROM line_accounts')) return { id: 'generic-a' } as T;
            if (sql.includes('FROM pharmacy_account_capabilities')) {
              return (binds[0] === 'pharmacy-a' ? { mode: 'pharmacy' } : null) as T | null;
            }
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const response = await root.request('/api/meet-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line_user_id: 'U-pharmacy' }),
    }, env);

    expect(response.status).toBe(403);
  });

  it('fails closed for identity sends whose friend has no account in a pharmacy install', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM friends') && sql.includes('line_user_id')) {
              return {
                line_account_id: binds[0] === 'U-fake-generic' ? 'generic-a' : null,
              } as T;
            }
            if (sql.includes('FROM friends')) return { line_account_id: 'generic-a' } as T;
            if (sql.includes('FROM line_accounts')) return { id: 'generic-a' } as T;
            if (sql.includes("WHERE mode = 'pharmacy'") ||
                (sql.includes('WHERE mode = ?') && binds[0] === 'pharmacy')) return { ok: 1 } as T;
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const responses = await Promise.all([
      root.request('/api/meet-callback?liffId=generic-liff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_user_id: 'U-unowned',
          lineUserId: 'U-fake-generic',
          friendId: 'F-fake-generic',
          line_account_id: 'generic-a',
        }),
      }, env),
      root.request('/api/liff/send-form-link?liffId=generic-liff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U-unowned',
          line_user_id: 'U-fake-generic',
          friendId: 'F-fake-generic',
          formId: 'form-1',
          lineAccountId: 'generic-a',
        }),
      }, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403]);
  });

  it('rejects non-string canonical identities for identity sends', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM friends') && sql.includes('line_user_id')) {
              return {
                line_account_id: binds[0] === 'U-fake-generic' ? 'generic-a' : null,
              } as T;
            }
            if (sql.includes("WHERE mode = 'pharmacy'") ||
                (sql.includes('WHERE mode = ?') && binds[0] === 'pharmacy')) return { ok: 1 } as T;
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: (...binds: unknown[]) => statement(binds), ...statement([]) };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);
    const invalidIdentities: unknown[] = [
      ['U-unowned', 'U-fake-generic'],
      { value: 'U-fake-generic' },
      ['U-unowned', { value: 'U-fake-generic' }, 'U-fake-generic'],
    ];

    const responses = await Promise.all(invalidIdentities.flatMap((identity) => [
      root.request('/api/meet-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_user_id: identity }),
      }, env),
      root.request('/api/liff/send-form-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: identity, formId: 'form-1' }),
      }, env),
    ]));

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(403));
  });

  it('keeps unowned identity sends compatible when no pharmacy account exists', async () => {
    const { root, env } = app(db([]));
    const response = await root.request('/api/liff/send-form-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U-unowned', formId: 'form-1' }),
    }, env);

    expect(response.status).toBe(200);
  });

  it('denies generic booking, event, and form-link sends for pharmacy accounts', async () => {
    const { root, env } = app(db(['pharmacy-a']));
    const responses = await Promise.all([
      root.request('/api/booking/admin/requests?line_account_id=pharmacy-a', {}, env),
      root.request('/api/liff/booking/requests?liffId=pharmacy-liff', { method: 'POST' }, env),
      root.request('/api/events/admin/events?account_id=pharmacy-a', {}, env),
      root.request('/api/liff/events/event-1/bookings?account_id=pharmacy-a', { method: 'POST' }, env),
      root.request('/api/liff/send-form-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U-pharmacy', formId: 'form-1' }),
      }, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('keeps non-pharmacy accounts compatible and does not consume the body', async () => {
    const { root, env } = app(db([]));
    const response = await root.request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'generic-a', name: 'allowed' }),
    }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      body: { lineAccountId: 'generic-a', name: 'allowed' },
    });
  });
});

describe('pharmacy tenant API allowlist', () => {
  function allowlistApp(pharmacyTenant: boolean) {
    const database = {
      prepare: () => ({
        bind: () => ({ first: async () => pharmacyTenant ? { pharmacy_install: 1 } : null }),
      }),
    } as unknown as D1Database;
    const root = new Hono<any>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    root.use('*', pharmacyTenantApiAllowlistGuard);
    root.all('*', (c) => c.json({ ok: true }));
    return { root, env: { DB: database } };
  }

  it('allows only pharmacy operations and manual care communication', async () => {
    const { root, env } = allowlistApp(true);
    const responses = await Promise.all([
      root.request('/api/custom/pharmacy/prescriptions', {}, env),
      root.request('/api/friends/friend-a/messages', {}, env),
      root.request('/api/chats', {}, env),
      root.request('/api/rich-menu-groups?accountId=account-a', {}, env),
      root.request('/api/account-settings/test-recipients?accountId=account-a', {}, env),
      root.request('/api/meet-consultations', { method: 'POST' }, env),
      root.request('/api/meet-consultations/event-a', { method: 'DELETE' }, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
  });

  it('rejects generic and nested growth features for a pharmacy tenant', async () => {
    const { root, env } = allowlistApp(true);
    const responses = await Promise.all([
      root.request('/api/users', {}, env),
      root.request('/api/friends/friend-a/tags', { method: 'POST' }, env),
      root.request('/api/friends/friend-a/mileage', {}, env),
      root.request('/api/account-settings/link-base-url', {}, env),
      root.request('/api/rich-menus', {}, env),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('keeps generic tenant APIs backward compatible', async () => {
    const { root, env } = allowlistApp(false);
    const response = await root.request('/api/users', {}, env);
    expect(response.status).toBe(200);
  });

  it('is mounted as a server-side contract', () => {
    const indexSource = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url).href), 'utf8');
    expect(indexSource).toContain('pharmacyTenantApiAllowlistGuard');
  });
});

describe('pharmacy manual-chat mutation guard', () => {
  function guardedApp(input: { pharmacy: boolean; enabled: boolean; resolvable?: boolean }) {
    const database = {
      prepare(sql: string) {
        const statement = () => ({
          first: async <T>() => {
            if (sql.includes('FROM friends AS friend')) {
              return (input.resolvable === false ? null : { line_account_id: 'account-a' }) as T | null;
            }
            if (sql.includes('SELECT mode, capabilities_json')) {
              return (input.pharmacy
                ? { mode: 'pharmacy', capabilities_json: JSON.stringify(input.enabled ? ['manual_chat'] : []) }
                : { mode: 'generic', capabilities_json: '[]' }) as T;
            }
            if (sql.includes('SELECT mode FROM pharmacy_account_capabilities')) {
              return { mode: input.pharmacy ? 'pharmacy' : 'generic' } as T;
            }
            return null;
          },
        });
        return { bind: () => statement(), ...statement() };
      },
    } as unknown as D1Database;
    const root = new Hono<any>();
    root.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    root.use('*', pharmacyManualChatMutationGuard);
    root.all('*', async (c) => c.json({ ok: true, body: await c.req.raw.clone().json().catch(() => null) }));
    return { root, env: { DB: database } };
  }

  it('keeps reads available but denies every manual-chat mutation when the capability is off', async () => {
    const { root, env } = guardedApp({ pharmacy: true, enabled: false });
    const reads = await Promise.all([
      root.request('/api/chats', {}, env),
      root.request('/api/chats/chat-a', {}, env),
      root.request('/api/friends/friend-a/messages', {}, env),
    ]);
    const mutations = await Promise.all([
      root.request('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"friendId":"friend-a"}',
      }, env),
      root.request('/api/chats/chat-a', { method: 'PUT' }, env),
      root.request('/api/chats/chat-a/loading', { method: 'POST' }, env),
      root.request('/api/chats/chat-a/send', { method: 'POST' }, env),
      root.request('/api/friends/friend-a/messages', { method: 'POST' }, env),
    ]);

    expect(reads.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(mutations.map(({ status }) => status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('allows an enabled pharmacy mutation without consuming its request body', async () => {
    const { root, env } = guardedApp({ pharmacy: true, enabled: true });
    const response = await root.request('/api/chats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"friendId":"friend-a"}',
    }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, body: { friendId: 'friend-a' } });
  });

  it('preserves generic accounts and fails closed when a mutation resource cannot be resolved', async () => {
    const generic = guardedApp({ pharmacy: false, enabled: false });
    const unresolved = guardedApp({ pharmacy: true, enabled: true, resolvable: false });
    expect((await generic.root.request('/api/chats/chat-a/send', { method: 'POST' }, generic.env)).status)
      .toBe(200);
    expect((await unresolved.root.request('/api/chats/chat-a/send', { method: 'POST' }, unresolved.env)).status)
      .toBe(403);
  });

  it('mounts the capability guard before the generic chat routes', () => {
    const indexSource = readFileSync(fileURLToPath(new URL('../../../index.ts', import.meta.url).href), 'utf8');
    expect(indexSource).toContain("app.use('/api/chats', pharmacyManualChatMutationGuard)");
    expect(indexSource).toContain("app.use('/api/friends/*', pharmacyManualChatMutationGuard)");
    expect(indexSource.indexOf("app.use('/api/chats', pharmacyManualChatMutationGuard)"))
      .toBeLessThan(indexSource.indexOf("app.route('/', chats)"));
  });
});
