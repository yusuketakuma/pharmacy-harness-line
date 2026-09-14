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

describe('retired tenant-owner CLI break-glass sessions', () => {
  it('returns 410 for issue and revoke without accepting the retired flow', async () => {
    const issue = await app().request(
      '/api/platform/pharmacy/tenants/tenant-a/cli-sessions',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer platform-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          platformAdminLoginId: 'platform-owner',
          reason: 'synthetic recovery',
        }),
      },
      env(),
    );
    const revoke = await app().request(
      '/api/platform/pharmacy/tenants/tenant-a/cli-sessions/11111111-1111-4111-8111-111111111111/revoke',
      { method: 'POST', headers: { authorization: 'Bearer platform-key' } },
      env(),
    );

    expect(issue.status).toBe(410);
    expect(revoke.status).toBe(410);
  });
});
