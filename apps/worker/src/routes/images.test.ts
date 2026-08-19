import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { images } from './images.js';

const r2 = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

function app() {
  const testApp = new Hono<{
    Bindings: { IMAGES: R2Bucket; WORKER_URL?: string };
    Variables: { tenantId: string; staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
  }>();
  testApp.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    c.set('staff', { id: 'staff-a', name: 'Staff A', role: 'staff' });
    await next();
  });
  testApp.route('/', images);
  return testApp;
}

function db(): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) { statement.values = values; return statement; },
        async first() {
          if (sql.includes('tenant_staff_memberships') && sql.includes('pharmacy_staff_accounts')) {
            return statement.values[0] === 'staff-a' && statement.values[1] === 'account-a'
              ? { tenant_id: 'tenant-a' }
              : null;
          }
          if (sql.includes('FROM line_accounts')) {
            return statement.values[0] === 'account-a'
              ? { tenant_id: 'tenant-a' }
              : statement.values[0] === 'account-b'
                ? { tenant_id: 'tenant-a' }
                : null;
          }
          if (sql.includes('pharmacy_staff_accounts')) {
            return statement.values[0] === 'account-a' && statement.values[2] === 'staff-a'
              ? { ok: 1 }
              : null;
          }
          return null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

beforeEach(() => vi.clearAllMocks());

describe('tenant-scoped image storage', () => {
  it('serves a private incoming image only inside the authenticated tenant', async () => {
    r2.get.mockResolvedValue({
      body: new Uint8Array([1]),
      etag: 'etag-1',
      httpMetadata: { contentType: 'image/jpeg' },
    });
    const env = { IMAGES: r2 as unknown as R2Bucket, DB: db() };

    const own = await app().request(
      '/api/images/tenants/tenant-a/accounts/account-a/incoming/message.jpg',
      undefined,
      env,
    );
    expect(own.status).toBe(200);
    expect(own.headers.get('Cache-Control')).toBe('private, no-store');

    r2.get.mockClear();
    const foreign = await app().request(
      '/api/images/tenants/tenant-b/accounts/account-b/incoming/message.jpg',
      undefined,
      env,
    );
    expect(foreign.status).toBe(404);
    expect(r2.get).not.toHaveBeenCalled();

    r2.get.mockClear();
    const sameTenantForeignAccount = await app().request(
      '/api/images/tenants/tenant-a/accounts/account-b/incoming/message.jpg',
      undefined,
      env,
    );
    expect(sameTenantForeignAccount.status).toBe(404);
    expect(r2.get).not.toHaveBeenCalled();
  });

  it('never exposes incoming patient images through the public image route', async () => {
    const res = await app().request(
      '/images/tenants/tenant-a/accounts/account-a/incoming/message.jpg',
      undefined,
      { IMAGES: r2 as unknown as R2Bucket, DB: db() },
    );
    expect(res.status).toBe(404);
    expect(r2.get).not.toHaveBeenCalled();
  });

  it('serves explicit public upload keys and rejects private namespaces before R2 access', async () => {
    r2.get.mockResolvedValue({
      body: new Uint8Array([1]),
      etag: 'etag-public',
      httpMetadata: { contentType: 'image/png' },
    });
    const env = { IMAGES: r2 as unknown as R2Bucket, DB: db() };
    const publicKey = '550e8400-e29b-41d4-a716-446655440000.png';

    const publicResponse = await app().request(`/images/${publicKey}`, undefined, env);
    expect(publicResponse.status).toBe(200);

    const tenantPublicKey = 'tenants/tenant-a/uploads/550e8400-e29b-41d4-a716-446655440000.png';
    const tenantPublicResponse = await app().request(`/images/${tenantPublicKey}`, undefined, env);
    expect(tenantPublicResponse.status).toBe(200);

    for (const privateKey of [
      'tenants/tenant-a/accounts/account-a/incoming/message.jpg',
      'rich-menus/account-a/group-a/page-a/menu.png',
      'custom/pharmacy/prescriptions/tenants/tenant-a/submission-a/1/file-a',
      'tenants/tenant.a/uploads/550e8400-e29b-41d4-a716-446655440000.png',
    ]) {
      r2.get.mockClear();
      const response = await app().request(`/images/${privateKey}`, undefined, env);
      expect(response.status).toBe(404);
      expect(r2.get).not.toHaveBeenCalled();
    }
  });

  it('stores new public uploads under the authenticated tenant prefix', async () => {
    r2.get.mockResolvedValue({
      body: new Uint8Array([1]),
      etag: 'etag-upload',
      httpMetadata: { contentType: 'image/png' },
    });
    const res = await app().request('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    }, {
      IMAGES: r2 as unknown as R2Bucket,
      DB: db(),
      WORKER_URL: 'https://worker.example.com',
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { data: { key: string; url: string } };
    expect(body.data.key).toMatch(/^tenants\/tenant-a\/uploads\/[0-9a-f-]+\.png$/);

    const publicResponse = await app().request(new URL(body.data.url).pathname, undefined, {
      IMAGES: r2 as unknown as R2Bucket,
      DB: db(),
    });
    expect(publicResponse.status).toBe(200);
    expect(r2.get).toHaveBeenCalledWith(body.data.key);
  });
});
