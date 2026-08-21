import { describe, expect, it, vi } from 'vitest';
import {
  getActiveMynaEndpoint,
  getAdminMynaEndpoint,
  markMynaEndpointVerified,
  saveMynaEndpoint,
  setMynaEndpointEnabled,
} from './endpoint-repository.js';
import { decryptEndpointUrl, encryptEndpointUrl, sha256Hex } from './endpoint.js';

function fakeDb(firstRows: unknown[], runChanges = 1) {
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
        return { success: true, meta: { changes: runChanges } };
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

  it('writes v2 ciphertext bound to the line account (AUTH-4)', async () => {
    const bound: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          if (sql.includes('INSERT INTO pharmacy_myna_endpoint_configs')) bound.push(values);
          return { first: async () => null, run: async () => ({ success: true, meta: { changes: 1 } }) };
        },
      }),
      batch: async (statements: unknown[]) => statements.map(() => ({ success: true, meta: { changes: 1 } })),
    } as unknown as D1Database;
    await saveMynaEndpoint(db, {
      lineAccountId: 'account-1', tenantAlias: 'pharmacy-a',
      endpointUrl: 'https://myna.example.test/pharmacy/a', enabled: true,
      staffId: 'staff-1', encryptionSecret: 'test-secret', allowedHosts: ['myna.example.test'],
    });
    const stored = bound[0]?.[3] as string;
    expect(stored.startsWith('v2.')).toBe(true);
    await expect(decryptEndpointUrl(stored, 'test-secret', { lineAccountId: 'account-1' }))
      .resolves.toBe('https://myna.example.test/pharmacy/a');
    await expect(decryptEndpointUrl(stored, 'test-secret', { lineAccountId: 'account-2' }))
      .rejects.toThrow();
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

  it('keeps the latest disabled endpoint visible to admins and can re-enable it', async () => {
    const encrypted = await encryptEndpointUrl(
      'https://myna.example.test/pharmacy/a', 'test-secret',
    );
    const disabled = {
      id: 'config-1', line_account_id: 'account-1', tenant_alias: 'pharmacy-a',
      endpoint_url_encrypted: encrypted,
      endpoint_url_hash: await sha256Hex('https://myna.example.test/pharmacy/a'),
      allowed_host: 'myna.example.test', enabled: 0,
      valid_from: '2026-08-17T00:00:00.000Z', retired_at: '2026-08-18T00:00:00.000Z',
      last_verified_at: null, revision: 1, created_by: 'staff-1', updated_by: 'staff-1',
      created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    };
    const { db, calls } = fakeDb([disabled, disabled, { ...disabled, enabled: 1, retired_at: null }]);

    await expect(getAdminMynaEndpoint(db, 'account-1', 'test-secret'))
      .resolves.toMatchObject({ enabled: false, endpoint_url_masked: 'https://myna.example.test/…' });
    await expect(setMynaEndpointEnabled(db, 'account-1', true, 1, 'staff-2', 'test-secret'))
      .resolves.toMatchObject({ enabled: true });
    expect(calls.some(({ sql, values }) =>
      sql.includes('SET enabled = ?') && sql.includes('revision = ?') &&
      values.includes(1) && values.includes('account-1'))).toBe(true);
  });

  it('rejects stale endpoint state and verification writes', async () => {
    const encrypted = await encryptEndpointUrl(
      'https://myna.example.test/pharmacy/a', 'test-secret',
    );
    const current = {
      id: 'config-1', line_account_id: 'account-1', tenant_alias: 'pharmacy-a',
      endpoint_url_encrypted: encrypted,
      endpoint_url_hash: await sha256Hex('https://myna.example.test/pharmacy/a'),
      allowed_host: 'myna.example.test', enabled: 1,
      valid_from: '2026-08-17T00:00:00.000Z', retired_at: null,
      last_verified_at: null, revision: 2, created_by: 'staff-1', updated_by: 'staff-1',
      created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    };
    const staleToggle = fakeDb([current], 0);
    await expect(setMynaEndpointEnabled(
      staleToggle.db, 'account-1', false, 1, 'staff-2', 'test-secret',
    )).rejects.toThrow('stale Myna endpoint revision');

    const staleVerification = fakeDb([], 0);
    await expect(markMynaEndpointVerified(staleVerification.db, 'account-1', 1))
      .rejects.toThrow('stale Myna endpoint revision');
    expect(staleVerification.calls[0].sql).toContain('revision = ?');
  });

  it('increments the revision when replacing a disabled endpoint', async () => {
    const encrypted = await encryptEndpointUrl(
      'https://myna.example.test/pharmacy/old', 'test-secret',
    );
    const disabled = {
      id: 'config-1', line_account_id: 'account-1', tenant_alias: 'pharmacy-a',
      endpoint_url_encrypted: encrypted,
      endpoint_url_hash: await sha256Hex('https://myna.example.test/pharmacy/old'),
      allowed_host: 'myna.example.test', enabled: 0,
      valid_from: '2026-08-17T00:00:00.000Z', retired_at: '2026-08-18T00:00:00.000Z',
      last_verified_at: null, revision: 1, created_by: 'staff-1', updated_by: 'staff-1',
      created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    };
    const { db, calls } = fakeDb([disabled]);

    await expect(saveMynaEndpoint(db, {
      lineAccountId: 'account-1', tenantAlias: 'pharmacy-a',
      endpointUrl: 'https://myna.example.test/pharmacy/new', enabled: true,
      staffId: 'staff-2', encryptionSecret: 'test-secret', allowedHosts: ['myna.example.test'],
    })).resolves.toMatchObject({ revision: 2, enabled: true });
    expect(calls[0].sql).not.toContain('retired_at IS NULL');
  });
});
