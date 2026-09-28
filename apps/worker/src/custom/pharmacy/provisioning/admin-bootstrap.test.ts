import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../index.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { tenantProvisioningRoutes } from './routes.js';

function env(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    PLATFORM_ADMIN_KEY: 'platform-key',
    API_KEY: 'tenant-key',
    LINE_CREDENTIAL_KEY_V1: 'line-credential-root-key-for-tests-v1',
  } as Env['Bindings'];
}

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', tenantProvisioningRoutes);
  return instance;
}

describe('retired individual tenant admin bootstrap', () => {
  it('returns 410 without reading or mutating tenant credentials', async () => {
    const response = await app().request(
      '/api/platform/pharmacy/tenants/tenant-a/admin-bootstrap',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer platform-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          loginId: 'admin-a',
          displayName: 'Owner A',
          temporaryPassword: 'Temporary pass 42',
        }),
      },
      env(),
    );

    expect(response.status).toBe(410);
    expect(JSON.stringify(await response.json())).not.toContain('Temporary pass 42');
  });
});
