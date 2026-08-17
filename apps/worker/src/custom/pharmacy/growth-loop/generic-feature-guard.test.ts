import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PHARMACY_DISABLED_GENERIC_API_PREFIXES,
  pharmacyGenericFeatureGuard,
} from './generic-feature-guard.js';

function db(pharmacyAccounts: string[]): D1Database {
  return {
    prepare(sql: string) {
      const statement = (binds: unknown[]) => ({
        first: async <T>() => {
          if (sql.includes('FROM pharmacy_account_capabilities')) {
            if (sql.includes("WHERE mode = 'pharmacy'")) {
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
      '/api/events', '/api/liff/events', '/api/liff/send-form-link',
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

  it('fails closed when an unscoped request cannot resolve the default in a pharmacy install', async () => {
    const database = {
      prepare(sql: string) {
        const statement = (binds: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes("WHERE mode = 'pharmacy'")) return { ok: 1 } as T;
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
        const statement = () => ({
          first: async <T>() => {
            if (sql.includes('FROM friends') && sql.includes('line_user_id')) {
              return { line_account_id: null } as T;
            }
            if (sql.includes('FROM line_accounts')) return { id: 'generic-a' } as T;
            if (sql.includes("WHERE mode = 'pharmacy'")) return { ok: 1 } as T;
            return null;
          },
          all: async <T>() => ({ results: [] as T[] }),
        });
        return { bind: () => statement(), ...statement() };
      },
    } as unknown as D1Database;
    const { root, env } = app(database);

    const responses = await Promise.all([
      root.request('/api/meet-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_user_id: 'U-unowned', line_account_id: 'generic-a' }),
      }, env),
      root.request('/api/liff/send-form-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: 'U-unowned', formId: 'form-1', lineAccountId: 'generic-a',
        }),
      }, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403]);
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
