import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { setup } from './setup.js';

function app(pharmacyInstall: boolean) {
  const root = new Hono<{ Bindings: { DB: D1Database } }>();
  root.route('/', setup);
  const statement = {
    bind() { return this; },
    first: async <T>() => (pharmacyInstall ? { ok: 1 } as T : null),
  };
  return {
    root,
    env: { DB: { prepare: () => statement } as unknown as D1Database },
  };
}

describe('legacy setup page', () => {
  it('is unavailable once the shared pharmacy installation exists', async () => {
    const { root, env } = app(true);
    expect((await root.request('/setup', {}, env)).status).toBe(404);
  });

  it('remains available for a generic non-pharmacy installation', async () => {
    const { root, env } = app(false);
    expect((await root.request('/setup', {}, env)).status).toBe(200);
  });
});
