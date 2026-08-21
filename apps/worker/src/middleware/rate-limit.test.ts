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
  a.post('/api/platform/pharmacy/tenants/:tenantId/admin-bootstrap', (c) => c.json({ success: true }));
  a.post(
    '/api/platform/pharmacy/tenants/:tenantId/line-accounts/:lineAccountId/credentials/scrub',
    (c) => c.json({ success: true }),
  );
  a.get('/api/liff/pharmacy/patients', (c) => c.json({ success: true }));
  a.get('/r/myna/:token', (c) => c.json({ success: true }));
  a.get('/r/other', (c) => c.json({ success: true }));
  return a;
}

// Real LINE ID tokens (JWTs) all share this fixed base64url-encoded header,
// so their first 16 characters are identical across every patient/tenant.
const JWT_HEADER_PREFIX = 'eyJhbGciOiJIUzI1NiJ9'; // {"alg":"HS256"}... (>16 chars)

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

describe('rate-limit token bucket key (H-1: shared-prefix JWT collision)', () => {
  test('two JWTs sharing the same first 16 characters get different bucket keys', async () => {
    const ip = '203.0.113.10';
    const a = app();
    const tokenA = `${JWT_HEADER_PREFIX}.payloadA.sigA`;
    const tokenB = `${JWT_HEADER_PREFIX}.payloadB.sigB`;
    expect(tokenA.slice(0, 16)).toBe(tokenB.slice(0, 16));

    // Exhaust token A's own bucket (AUTHENTICATED_MAX = 1000).
    for (let i = 0; i < 1000; i++) {
      const res = await a.request('/api/protected', {
        headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${tokenA}` },
      }, env);
      expect(res.status).toBe(200);
    }
    const blockedA = await a.request('/api/protected', {
      headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${tokenA}` },
    }, env);
    expect(blockedA.status).toBe(429);

    // Token B shares the first 16 chars with token A but is otherwise
    // distinct — it must land in its own, still-fresh bucket.
    const resB = await a.request('/api/protected', {
      headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${tokenB}` },
    }, env);
    expect(resB.status).toBe(200);
  });

  test('many arbitrary, unvalidated Bearer tokens do not drain a distinct legitimate token bucket', async () => {
    const ip = '203.0.113.11';
    const a = app();

    // An unauthenticated attacker can send any syntactically Bearer-shaped
    // value — no valid token required, since rate limiting runs before auth.
    for (let i = 0; i < 50; i++) {
      const res = await a.request('/api/protected', {
        headers: {
          'cf-connecting-ip': ip,
          Authorization: `Bearer ${JWT_HEADER_PREFIX}.attacker${i}.sig${i}`,
        },
      }, env);
      expect(res.status).toBe(200);
    }

    // The real caller's own distinct token must still have its full,
    // untouched allowance despite sharing the header prefix with every
    // attacker request above.
    const legitToken = `${JWT_HEADER_PREFIX}.legit-payload.legit-sig`;
    for (let i = 0; i < 1000; i++) {
      const res = await a.request('/api/protected', {
        headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${legitToken}` },
      }, env);
      expect(res.status).toBe(200);
    }
    const blocked = await a.request('/api/protected', {
      headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${legitToken}` },
    }, env);
    expect(blocked.status).toBe(429);
  });
});

describe('rate-limit unauthenticated classification (H-1: pharmacy LIFF)', () => {
  test('pharmacy LIFF patient routes are IP-keyed, not token-keyed', async () => {
    const ip = '203.0.113.12';
    const a = app();
    // UNAUTHENTICATED_MAX = 100. If this path were still treated as
    // authenticated, an unvalidated Bearer token would grant AUTHENTICATED_MAX
    // (1000) instead — so this proves the pharmacy LIFF prefix is classified
    // as unauthenticated regardless of an attached Bearer token.
    for (let i = 0; i < 100; i++) {
      const res = await a.request('/api/liff/pharmacy/patients', {
        headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${JWT_HEADER_PREFIX}.p${i}.s${i}` },
      }, env);
      expect(res.status).toBe(200);
    }
    const blocked = await a.request('/api/liff/pharmacy/patients', {
      headers: { 'cf-connecting-ip': ip, Authorization: `Bearer ${JWT_HEADER_PREFIX}.over.sig` },
    }, env);
    expect(blocked.status).toBe(429);
  });
});

describe('rate-limit unauthenticated classification (NEXT-1: Myna launch redirect)', () => {
  test('/r/myna/:token is IP-keyed and limited, unlike /r/other which is skipped', async () => {
    const ip = '203.0.113.90';
    const a = app();
    for (let i = 0; i < 100; i++) {
      const res = await a.request('/r/myna/some-token', { headers: { 'cf-connecting-ip': ip } }, env);
      expect(res.status).toBe(200);
    }
    const blocked = await a.request('/r/myna/some-token', { headers: { 'cf-connecting-ip': ip } }, env);
    expect(blocked.status).toBe(429);

    // /r/ prefix in general (e.g. non-Myna share links) stays skipped: unlimited.
    for (let i = 0; i < 101; i++) {
      const res = await a.request('/r/other', { headers: { 'cf-connecting-ip': ip } }, env);
      expect(res.status).toBe(200);
    }
  });
});

describe('rate-limit SENSITIVE_PATHS (L-8: platform pharmacy tenant sub-paths)', () => {
  const ipByPath: Record<string, string> = {
    '/api/platform/pharmacy/tenants/tenant-1/admin-bootstrap': '203.0.113.30',
    '/api/platform/pharmacy/tenants/tenant-1/line-accounts/account-1/credentials/scrub': '203.0.113.31',
  };

  test.each(Object.keys(ipByPath))('limits %s to ten attempts per minute', async (path) => {
    const ip = ipByPath[path];
    const a = app();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await a.request(path, {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip },
      }, env);
      expect(response.status).toBe(200);
    }
    const blocked = await a.request(path, {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip },
    }, env);
    expect(blocked.status).toBe(429);
  });
});

describe('rate-limit SENSITIVE_PATHS (percent-encoded path bypass)', () => {
  test('an encoded login path is still limited to ten attempts per minute', async () => {
    const a = app();
    a.post('/api/platform-admin/login', (c) => c.json({ success: true }));
    const encoded = '/api/platform-admin/log%69n';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await a.request(encoded, {
        method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.50' },
      }, env);
      expect(response.status).toBe(200);
    }
    const blocked = await a.request(encoded, {
      method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.50' },
    }, env);
    expect(blocked.status).toBe(429);
  });
});

describe('rate-limit SENSITIVE_PATHS (AUTH-2: platform-admin login / password change)', () => {
  const ipByPath: Record<string, string> = {
    '/api/platform-admin/login': '203.0.113.40',
    '/api/platform-admin/change-password': '203.0.113.41',
    '/api/auth/change-password': '203.0.113.42',
  };

  test.each(Object.keys(ipByPath))('limits %s to ten attempts per minute', async (path) => {
    const ip = ipByPath[path];
    const a = app();
    a.post(path, (c) => c.json({ success: true }));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await a.request(path, {
        method: 'POST',
        headers: { 'cf-connecting-ip': ip, Authorization: `Bearer rotated-${attempt}` },
      }, env);
      expect(response.status).toBe(200);
    }
    const blocked = await a.request(path, {
      method: 'POST',
      headers: { 'cf-connecting-ip': ip, Authorization: 'Bearer another-value' },
    }, env);
    expect(blocked.status).toBe(429);
  });
});
