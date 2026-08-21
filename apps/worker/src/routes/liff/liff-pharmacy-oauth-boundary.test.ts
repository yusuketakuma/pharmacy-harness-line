import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../index.js';
import { liffRoutes } from './liff.js';

const DB = {
  prepare: () => ({
    bind: () => ({ first: async () => ({ ok: 1 }) }),
  }),
} as unknown as D1Database;

describe('legacy LINE OAuth boundary in pharmacy mode', () => {
  it.each([
    { method: 'GET', path: '/auth/line' },
    { method: 'GET', path: '/auth/oauth' },
    {
      method: 'GET',
      path: `/auth/callback?code=forged&state=${btoa(JSON.stringify({ account: 'other-tenant' }))}`,
    },
    { method: 'POST', path: '/api/liff/link' },
    { method: 'POST', path: '/api/liff/send-form-link' },
  ])('rejects $method $path before resolving an account or calling LINE', async ({ method, path }) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request(path, { method }, { DB } as Env['Bindings']);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns only ordered patient capabilities without calling LINE', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('FROM pharmacy_account_capabilities') ? { ok: 1 } : null,
          all: async () => ({ results: [{
            id: 'account-a', name: '薬局A', mode: 'pharmacy',
            capabilities_json: JSON.stringify([
              'pharmacy_info', 'account_settings', 'unknown', 'emergency_contraception',
            ]),
            capability_revision: 7,
          }] }),
        }),
      }),
    } as unknown as D1Database;
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request('/api/liff/config?liffId=pharmacy-liff', {}, { DB: db } as Env['Bindings']);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ data: {
      accountId: 'account-a',
      enabledFeatures: ['emergency_contraception', 'pharmacy_info'],
      capabilityRevision: 7,
    } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when one LIFF ID resolves to multiple active accounts', async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('FROM pharmacy_account_capabilities') ? { ok: 1 } : null,
          all: async () => ({ results: [{ id: 'account-a' }, { id: 'account-b' }] }),
        }),
      }),
    } as unknown as D1Database;
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request('/api/liff/config?liffId=ambiguous', {}, { DB: db } as Env['Bindings']);

    expect(response.status).toBe(409);
  });

  it('keeps the tenant-bound profile endpoint available to the dedicated pharmacy LIFF', async () => {
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request('/api/liff/profile', { method: 'POST' }, {
      DB,
    } as Env['Bindings']);

    expect(response.status).toBe(401);
  });
});
