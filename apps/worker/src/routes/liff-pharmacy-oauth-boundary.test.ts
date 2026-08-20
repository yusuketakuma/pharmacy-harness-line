import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
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
    { method: 'GET', path: '/api/liff/config?liffId=legacy-pharmacy-liff' },
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

  it('keeps the tenant-bound profile endpoint available to the dedicated pharmacy LIFF', async () => {
    const app = new Hono<Env>();
    app.route('/', liffRoutes);

    const response = await app.request('/api/liff/profile', { method: 'POST' }, {
      DB,
    } as Env['Bindings']);

    expect(response.status).toBe(401);
  });
});
