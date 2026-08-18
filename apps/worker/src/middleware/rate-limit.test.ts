import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from './rate-limit.js';
import type { Env } from '../index.js';

function app() {
  const a = new Hono<Env>();
  a.use('*', rateLimitMiddleware);
  a.get('/api/protected', (c) => c.json({ success: true }));
  a.post('/api/auth/login', (c) => c.json({ success: true }));
  a.post('/api/platform/pharmacy/tenants', (c) => c.json({ success: true }));
  return a;
}

const env = {} as Env['Bindings'];

describe('rate-limit IP ceiling (pre-auth token rotation)', () => {
  test.each(['/api/auth/login', '/api/platform/pharmacy/tenants'])(
    'limits the sensitive unauthenticated endpoint %s to ten attempts per minute',
    async (path) => {
      const ip = path.includes('platform') ? '203.0.113.201' : '203.0.113.202';
      const a = app();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await a.request(path, {
          method: 'POST',
          headers: {
            'cf-connecting-ip': ip,
            Authorization: `Bearer rotated-${attempt}`,
          },
        }, env);
        expect(response.status).toBe(200);
      }
      const blocked = await a.request(path, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': ip,
          Authorization: 'Bearer another-value',
        },
      }, env);
      expect(blocked.status).toBe(429);
    },
  );

  test('rotating unvalidated session cookies from one IP cannot bypass the limiter', async () => {
    // A unique IP isolates this test from the module-level store. Each request
    // uses a DIFFERENT bogus cookie, so the per-token bucket never trips — only
    // the per-IP ceiling (3000) should eventually return 429.
    const ip = '203.0.113.77';
    const a = app();
    let saw429 = false;

    for (let i = 0; i < 3001; i++) {
      const res = await a.request('/api/protected', {
        headers: {
          'cf-connecting-ip': ip,
          Cookie: `lh_admin_session=bogus-${i}`,
        },
      }, env);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }

    expect(saw429).toBe(true);
  });

  test('a single legitimate token keeps its full allowance from one IP', async () => {
    const ip = '198.51.100.42';
    const a = app();
    // Well under both AUTHENTICATED_MAX and the IP ceiling.
    for (let i = 0; i < 50; i++) {
      const res = await a.request('/api/protected', {
        headers: { 'cf-connecting-ip': ip, Cookie: 'lh_admin_session=stable-token' },
      }, env);
      expect(res.status).toBe(200);
    }
  });
});
