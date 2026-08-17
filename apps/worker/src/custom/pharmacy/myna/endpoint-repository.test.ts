import { describe, expect, it, vi } from 'vitest';
import { getActiveMynaEndpoint, saveMynaEndpoint } from './endpoint-repository.js';
import { encryptEndpointUrl, sha256Hex } from './endpoint.js';

function fakeDb(firstRows: unknown[]) {
  const rows = [...firstRows];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        calls.push({ sql, values });
        return rows.shift() ?? null;
      },
      run: async () => {
        calls.push({ sql, values });
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const db = {
    prepare,
    batch: async (statements: unknown[]) => {
      calls.push({ sql: `BATCH ${statements.length}`, values: [] });
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('Myna endpoint repository', () => {
  it('stores the endpoint encrypted and exposes no plaintext URL to admin reads', async () => {
    const { db, calls } = fakeDb([null]);
    const saved = await saveMynaEndpoint(db, {
      lineAccountId: 'account-1',
      tenantAlias: 'pharmacy-a',
      endpointUrl: 'https://myna.example.test/pharmacy/a',
      enabled: true,
      staffId: 'staff-1',
      encryptionSecret: 'test-secret',
      allowedHosts: ['myna.example.test'],
    });
    expect(saved.endpoint_url_masked).toBe('https://myna.example.test/…');
    expect(calls.some((call) => call.values.includes('https://myna.example.test/pharmacy/a'))).toBe(false);
  });

  it('decrypts only the active account-scoped endpoint', async () => {
    const { db: setupDb } = fakeDb([null]);
    await saveMynaEndpoint(setupDb, {
      lineAccountId: 'account-1', tenantAlias: 'pharmacy-a',
      endpointUrl: 'https://myna.example.test/pharmacy/a', enabled: true,
      staffId: 'staff-1', encryptionSecret: 'test-secret', allowedHosts: ['myna.example.test'],
    });
    const encrypted = await encryptEndpointUrl(
      'https://myna.example.test/pharmacy/a', 'test-secret',
    );
    const { db } = fakeDb([{
      id: 'config-1', line_account_id: 'account-1', tenant_alias: 'pharmacy-a',
      endpoint_url_encrypted: encrypted,
      endpoint_url_hash: await sha256Hex('https://myna.example.test/pharmacy/a'),
      allowed_host: 'myna.example.test',
      enabled: 1, valid_from: '2026-08-17T00:00:00.000Z', retired_at: null,
      last_verified_at: null, revision: 1, created_by: 'staff-1', updated_by: 'staff-1',
      created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z',
    }]);
    await expect(getActiveMynaEndpoint(db, 'account-1', 'test-secret'))
      .resolves.toMatchObject({ tenant_alias: 'pharmacy-a', endpoint_url: 'https://myna.example.test/pharmacy/a' });
  });
});
