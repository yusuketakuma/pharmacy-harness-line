import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware, authenticateApiToken } from './auth.js';
import { CORS_ALLOW_HEADERS, resolveCorsOrigin } from './admin-auth-config.js';
import { adminAuth } from '../routes/admin-auth.js';
import type { Env } from '../index.js';

vi.mock('@line-crm/db', () => ({
  getStaffByApiKey: vi.fn(async (_db: unknown, token: string) => {
    if (token !== 'staff-key') return null;
    return { id: 'staff-1', name: 'Staff One', role: 'admin' };
  }),
}));

const PAGES = 'https://your-admin.pages.dev';
const LIFF = 'https://your-liff.pages.dev';
const WORKERS = 'https://your-worker.your-subdomain.workers.dev';
const TENANT_ID = 'tenant:pharmacy-a';
const TENANT_CODE = 'pharmacy-a';

function tenantDb(pharmacyMode = 1): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('FROM tenants')) {
                return values.includes(TENANT_ID) || values.includes(TENANT_CODE)
                  ? {
                      id: TENANT_ID,
                      tenant_code: TENANT_CODE,
                      display_name: 'Pharmacy A',
                      pharmacy_mode: pharmacyMode,
                    }
                  : null;
              }
              if (sql.includes('FROM tenant_staff_memberships')) {
                return values.includes('staff-1') && values.includes(TENANT_ID)
                  ? { role: 'admin' }
                  : null;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: tenantDb(),
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'env-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'line-channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: WORKERS,
    ...overrides,
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-token-key-for-tests',
  };
}

// Cross-site production topology with explicit opt-in (the supported case).
function crossSiteEnv(): Env['Bindings'] {
  return env({ ADMIN_ORIGIN: PAGES, ADMIN_ALLOW_CROSS_SITE: 'true' });
}

function app() {
  const a = new Hono<Env>();
  a.use('*', cors({
    origin: (origin, c) => resolveCorsOrigin(c.env, origin, c.req.url),
    credentials: true,
    allowHeaders: CORS_ALLOW_HEADERS,
  }));
  a.use('*', authMiddleware);
  a.route('/', adminAuth);
  a.get('/api/protected', (c) => c.json({
    success: true,
    data: { ...c.get('staff'), tenantId: c.get('tenantId') },
  }));
  a.post('/api/protected', (c) => c.json({ success: true, data: c.get('staff') }));
  a.get('/api/forms/:id', (c) => c.json({ success: true, staff: c.get('staff') ?? null }));
  a.put('/api/forms/:id', (c) => c.json({ success: true }));
  a.delete('/api/forms/:id', (c) => c.json({ success: true }));
  a.post('/api/forms/:id/submit', (c) => c.json({ success: true }));
  a.post('/api/forms/:id/partial', (c) => c.json({ success: true }));
  a.post('/api/forms/:id/opened', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/prescriptions', (c) => c.json({ success: true }));
  a.delete('/api/liff/pharmacy/prescriptions', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/myna-handoffs', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/myna-handoffs/:id/launch', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/continuity/expectations/:id/respond', (c) => c.json({ success: true }));
  a.get('/api/liff/pharmacy/medication-followups', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/medication-followups/:id/respond', (c) => c.json({ success: true }));
  a.get('/api/liff/pharmacy/emergency-contraception', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/emergency-contraception/intakes', (c) => c.json({ success: true }));
  a.post('/api/liff/pharmacy/emergency-contraception/intakes/:id/cancel', (c) => c.json({ success: true }));
  a.get('/api/liff/pharmacy/public-profile', (c) => c.json({ success: true }));
  a.delete('/api/liff/pharmacy/public-profile', (c) => c.json({ success: true }));
  a.get('/api/booking/google-calendar/oauth/callback', (c) => c.text('oauth-callback'));
  a.post('/api/booking/google-calendar/oauth/callback', (c) => c.text('wrong-method'));
  return a;
}

function setCookies(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie();
  const single = res.headers.get('Set-Cookie');
  return single ? [single] : [];
}

function cookieFor(res: Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

describe('admin login boundary', () => {
  test('does not allow the retired browser API-key header through CORS', () => {
    expect(CORS_ALLOW_HEADERS.map((header) => header.toLowerCase()))
      .not.toContain('x-admin-api-key');
  });

  test('rejects legacy API-key browser login without issuing cookies', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'staff-key', pharmacyCode: TENANT_CODE }),
      headers: { 'Content-Type': 'application/json' },
    }, crossSiteEnv());
    expect(res.status).toBe(400);
    expect(cookieFor(res, 'lh_admin_session')).toBeUndefined();
    expect(cookieFor(res, 'lh_tenant')).toBeUndefined();
  });

  test('runs password verification even when the tenant login does not exist', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        pharmacyCode: 'missing',
        loginId: 'missing',
        password: 'A guessed password 42',
      }),
      headers: { 'Content-Type': 'application/json' },
    }, crossSiteEnv());

    expect(res.status).toBe(401);
    expect(derive).toHaveBeenCalledTimes(1);
    derive.mockRestore();
  });
});

describe('topology guard', () => {
  test('cross-site WITHOUT opt-in refuses login with an actionable error', async () => {
    const res = await app().request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        pharmacyCode: TENANT_CODE,
        loginId: 'admin',
        password: 'Temporary password 42',
      }),
      headers: { 'Content-Type': 'application/json' },
    }, env({ ADMIN_ORIGIN: PAGES })); // no ADMIN_ALLOW_CROSS_SITE

    expect(res.status).toBe(500);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/cross-site/i);
    expect(cookieFor(res, 'lh_admin_session')).toBeUndefined();
  });
});

describe('protected API access', () => {
  test('allows LIFF preflight requests for pharmacy APIs', async () => {
    const res = await app().request('/api/liff/pharmacy/patients?liffId=test', {
      method: 'OPTIONS',
      headers: {
        Origin: LIFF,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    }, env({ LIFF_ORIGIN: LIFF }));

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(LIFF);
  });

  test('allows Idempotency-Key in cross-origin preflight requests', async () => {
    const res = await app().request('/api/liff/booking/requests?liffId=test', {
      method: 'OPTIONS',
      headers: {
        Origin: LIFF,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, idempotency-key',
      },
    }, env({ LIFF_ORIGIN: LIFF }));

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('idempotency-key');
  });

  test('protects rich-menu image proxies instead of relying on an unguessable R2 key', async () => {
    const image = await app().request('/api/rich-menu-images/account/group/page/image.png', {}, crossSiteEnv());
    const external = await app().request('/api/rich-menu-groups/external/richmenu-1/image?accountId=account-1', {}, crossSiteEnv());
    expect(image.status).toBe(401);
    expect(external.status).toBe(401);
  });

  test('rejects an API key smuggled through the browser session cookie', async () => {
    const res = await app().request('/api/protected', {
      headers: { Cookie: `lh_admin_session=staff-key; lh_tenant=${encodeURIComponent(TENANT_ID)}` },
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test('rejects a valid session cookie without its tenant binding', async () => {
    const res = await app().request('/api/protected', {
      headers: { Cookie: 'lh_admin_session=staff-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test('still accepts Bearer tokens for SDK / MCP callers', async () => {
    const res = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer staff-key', 'X-Tenant-Id': TENANT_ID },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string } };
    expect(body.data).toMatchObject({ id: 'staff-1', role: 'admin' });
  });

  test('does not let the global env key select arbitrary tenants by default', async () => {
    const denied = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer env-key', 'X-Tenant-Id': TENANT_ID },
    }, crossSiteEnv());
    expect(denied.status).toBe(401);

    const legacy = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer env-key', 'X-Tenant-Id': TENANT_ID },
    }, env({
      ADMIN_ORIGIN: PAGES,
      ADMIN_ALLOW_CROSS_SITE: 'true',
      LEGACY_ENV_OWNER_BYPASS: 'true',
    }));
    expect(legacy.status).toBe(401);
  });

  test('rejects a Bearer token without an explicit tenant header', async () => {
    const res = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer env-key' },
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test('rejects requests with no credentials', async () => {
    const res = await app().request('/api/protected', {}, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test('a malformed cookie value yields 401, not a 500', async () => {
    // `%` is an invalid percent escape — decoding must not throw.
    const res = await app().request('/api/protected', {
      headers: { Cookie: 'lh_admin_session=%; other=%E0%A4%A' },
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });
});

describe('LEGACY_ENV_OWNER_BYPASS logging', () => {
  test('logs accept_via=LEGACY_ENV_OWNER_BYPASS when the bypass path is actually taken', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer env-key', 'X-Tenant-Id': TENANT_ID },
    }, env({
      DB: tenantDb(0), // non-pharmacy-mode tenant: the only case the bypass fires for
      ADMIN_ORIGIN: PAGES,
      ADMIN_ALLOW_CROSS_SITE: 'true',
      LEGACY_ENV_OWNER_BYPASS: 'true',
    }));
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledWith(`[auth] accept_via=LEGACY_ENV_OWNER_BYPASS tenant=${TENANT_ID}`);
    log.mockRestore();
  });
});

describe('constant-time secret comparison', () => {
  function fakeContext(overrides: Partial<Env['Bindings']> = {}): Context<Env> {
    return { env: env(overrides) } as unknown as Context<Env>;
  }

  test('API_KEY: accepts an exact match', async () => {
    const staff = await authenticateApiToken(fakeContext(), 'env-key');
    expect(staff).toMatchObject({ id: 'env-owner' });
  });

  test('API_KEY: rejects a same-length near-miss', async () => {
    // 'env-key' is 7 chars; 'env-kex' is also 7 chars but does not match.
    const staff = await authenticateApiToken(fakeContext(), 'env-kex');
    expect(staff).toBeNull();
  });

  test('API_KEY: rejects a different-length near-miss', async () => {
    const staff = await authenticateApiToken(fakeContext(), 'env-key-but-longer');
    expect(staff).toBeNull();
  });

  test('LEGACY_API_KEY: accepts an exact match', async () => {
    const staff = await authenticateApiToken(
      fakeContext({ LEGACY_API_KEY: 'legacy-key' }),
      'legacy-key',
    );
    expect(staff).toMatchObject({ id: 'env-owner' });
  });

  test('LEGACY_API_KEY: rejects a same-length near-miss', async () => {
    // Same length as 'legacy-key' (10 chars), differs in the last character.
    const staff = await authenticateApiToken(
      fakeContext({ LEGACY_API_KEY: 'legacy-key' }),
      'legacy-kex',
    );
    expect(staff).toBeNull();
  });

  test('LEGACY_API_KEY: rejects a different-length near-miss', async () => {
    const staff = await authenticateApiToken(
      fakeContext({ LEGACY_API_KEY: 'legacy-key' }),
      'legacy-key-but-longer',
    );
    expect(staff).toBeNull();
  });
});

describe('public form method boundaries', () => {
  test('allows unauthenticated GET of a form definition', async () => {
    const res = await app().request('/api/forms/form-1', {}, crossSiteEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { staff: unknown }).staff).toBeNull();
  });

  test('authenticates an admin GET so the route can return private settings', async () => {
    const res = await app().request('/api/forms/form-1', {
      headers: { Authorization: 'Bearer staff-key', 'X-Tenant-Id': TENANT_ID },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { staff: { role: string } }).staff.role).toBe('admin');
  });

  test.each(['PUT', 'DELETE'])('%s on the same form path requires admin auth', async (method) => {
    const res = await app().request('/api/forms/form-1', { method }, crossSiteEnv());
    expect(res.status).toBe(401);
  });

  test.each(['submit', 'partial', 'opened'])(
    'allows POST /%s through to route-level LIFF authentication',
    async (action) => {
      const res = await app().request(`/api/forms/form-1/${action}`, {
        method: 'POST',
      }, crossSiteEnv());
      expect(res.status).toBe(200);
    },
  );

  test('does not exempt the wrong method on a public action path', async () => {
    const res = await app().request('/api/forms/form-1/submit', {
      method: 'DELETE',
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });
});

describe('Google OAuth callback boundary', () => {
  test('allows only unauthenticated GET callback through to signed-state validation', async () => {
    const get = await app().request(
      '/api/booking/google-calendar/oauth/callback?state=signed&code=code',
      {},
      crossSiteEnv(),
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('oauth-callback');

    const post = await app().request('/api/booking/google-calendar/oauth/callback', {
      method: 'POST',
    }, crossSiteEnv());
    expect(post.status).toBe(401);
  });
});

describe('prescription LIFF auth boundary', () => {
  test('allows only the explicitly supported method through to LINE verification', async () => {
    const post = await app().request('/api/liff/pharmacy/prescriptions', {
      method: 'POST',
    }, crossSiteEnv());
    expect(post.status).toBe(200);

    const wrongMethod = await app().request('/api/liff/pharmacy/prescriptions', {
      method: 'DELETE',
    }, crossSiteEnv());
    expect(wrongMethod.status).toBe(401);
  });
});

describe('Myna LIFF auth boundary', () => {
  test('allows only the supported patient actions through to LINE verification', async () => {
    const post = await app().request('/api/liff/pharmacy/myna-handoffs', {
      method: 'POST',
    }, crossSiteEnv());
    expect(post.status).toBe(200);

    const launch = await app().request('/api/liff/pharmacy/myna-handoffs/handoff-1/launch', {
      method: 'POST',
    }, crossSiteEnv());
    expect(launch.status).toBe(200);
  });

  test('does not exempt the wrong method on a Myna patient action path', async () => {
    const res = await app().request('/api/liff/pharmacy/myna-handoffs/handoff-1/launch', {
      method: 'DELETE',
    }, crossSiteEnv());
    expect(res.status).toBe(401);
  });
});

describe('continuity LIFF auth boundary', () => {
  test('lets a patient response reach route-level LINE verification', async () => {
    const response = await app().request(
      '/api/liff/pharmacy/continuity/expectations/expectation-1/respond',
      { method: 'POST' },
      crossSiteEnv(),
    );
    expect(response.status).toBe(200);
  });

  test('does not exempt an unsupported method on the same path', async () => {
    const response = await app().request(
      '/api/liff/pharmacy/continuity/expectations/expectation-1/respond',
      { method: 'DELETE' },
      crossSiteEnv(),
    );
    expect(response.status).toBe(401);
  });
});

describe('pharmacy follow-up and emergency LIFF auth boundary', () => {
  test.each([
    ['GET', '/api/liff/pharmacy/medication-followups'],
    ['POST', '/api/liff/pharmacy/medication-followups/followup-1/respond'],
    ['GET', '/api/liff/pharmacy/emergency-contraception'],
    ['POST', '/api/liff/pharmacy/emergency-contraception/intakes'],
    ['POST', '/api/liff/pharmacy/emergency-contraception/intakes/intake-1/cancel'],
  ])('lets %s %s reach route-level LINE verification', async (method, path) => {
    const response = await app().request(path, { method }, crossSiteEnv());
    expect(response.status).toBe(200);
  });

  test.each([
    ['DELETE', '/api/liff/pharmacy/medication-followups'],
    ['GET', '/api/liff/pharmacy/medication-followups/followup-1/respond'],
    ['DELETE', '/api/liff/pharmacy/emergency-contraception/intakes'],
    ['GET', '/api/liff/pharmacy/emergency-contraception/intakes/intake-1/cancel'],
  ])('does not exempt unsupported %s %s', async (method, path) => {
    const response = await app().request(path, { method }, crossSiteEnv());
    expect(response.status).toBe(401);
  });
});

describe('pharmacy public-profile LIFF auth boundary', () => {
  test('allows only GET through to route-level LINE verification', async () => {
    expect((await app().request('/api/liff/pharmacy/public-profile', {}, crossSiteEnv())).status).toBe(200);
    expect((await app().request('/api/liff/pharmacy/public-profile', {
      method: 'DELETE',
    }, crossSiteEnv())).status).toBe(401);
  });
});

describe('CSRF protection', () => {
  test('Bearer POST is exempt from CSRF (not cookie-driven)', async () => {
    const res = await app().request('/api/protected', {
      method: 'POST',
      headers: { Authorization: 'Bearer staff-key', 'X-Tenant-Id': TENANT_ID },
    }, crossSiteEnv());
    expect(res.status).toBe(200);
  });
});

describe('logout', () => {
  test('expires the session, tenant, and CSRF cookies', async () => {
    const res = await app().request('/api/auth/logout', { method: 'POST' }, crossSiteEnv());
    expect(res.status).toBe(200);
    const session = cookieFor(res, 'lh_admin_session') ?? '';
    const tenant = cookieFor(res, 'lh_tenant') ?? '';
    const csrf = cookieFor(res, 'lh_csrf') ?? '';
    expect(session).toContain('Max-Age=0');
    expect(tenant).toContain('Max-Age=0');
    expect(csrf).toContain('Max-Age=0');
  });
});

describe('CORS allowed / blocked origins', () => {
  test('allowlisted admin origin is echoed back', async () => {
    const res = await app().request('/api/protected', {
      headers: { Origin: PAGES, Cookie: `lh_admin_session=staff-key; lh_tenant=${encodeURIComponent(TENANT_ID)}` },
    }, crossSiteEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(PAGES);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('Cloudflare Pages preview origin for the admin project is echoed back', async () => {
    const preview = 'https://abc123.your-admin.pages.dev';
    const res = await app().request('/api/protected', {
      headers: { Origin: preview, Cookie: `lh_admin_session=staff-key; lh_tenant=${encodeURIComponent(TENANT_ID)}` },
    }, crossSiteEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(preview);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('login preflight succeeds from a Cloudflare Pages preview origin', async () => {
    const preview = 'https://abc123.your-admin.pages.dev';
    const res = await app().request('/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: preview,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }, crossSiteEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(preview);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  test('unknown origin gets no Access-Control-Allow-Origin header', async () => {
    const res = await app().request('/api/protected', {
      headers: { Origin: 'https://evil.example.com', Cookie: `lh_admin_session=staff-key; lh_tenant=${encodeURIComponent(TENANT_ID)}` },
    }, crossSiteEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
