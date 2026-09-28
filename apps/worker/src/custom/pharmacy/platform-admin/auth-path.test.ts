import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../../index.js';
import { platformAdminAuthMiddleware } from './auth.js';

describe('platform admin authentication uses the routed path', () => {
  function app() {
    const root = new Hono<Env>();
    root.use('/api/platform-admin/*', platformAdminAuthMiddleware);
    root.post('/api/platform-admin/login', (c) => c.text('login handler'));
    root.get('/api/platform-admin/session', (c) => c.text('protected handler'));
    return root;
  }

  it.each(['/api/platform-admin/login', '/api/platform-admin/log%69n'])(
    'allows the login handler to authenticate the request: %s',
    async (path) => {
      const response = await app().request(path, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('login handler');
      expect(response.headers.get('cache-control')).toBe('no-store, private');
    },
  );

  it.each(['/api/platform-admin/session', '/%61pi/platform-admin/session', '/api/platform-admin/sess%69on'])(
    'keeps sessions protected: %s',
    async (path) => {
      const response = await app().request(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ success: false, error: 'Unauthorized' });
    },
  );
});
