import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getActiveTenantLineAccounts: vi.fn(),
  updateLineAccount: vi.fn(),
}));
const credentials = vi.hoisted(() => ({
  readLineCredential: vi.fn(),
  writeLineCredential: vi.fn(),
}));
const accounts = vi.hoisted(() => ({
  updateEncryptedLineAccount: vi.fn(),
}));

vi.mock('@line-crm/db', () => db);
vi.mock('../custom/pharmacy/provisioning/line-credential-store.js', () => credentials);
vi.mock('../custom/pharmacy/provisioning/line-account-store.js', () => accounts);

import { refreshLineAccessTokens } from './token-refresh.js';

describe('refreshLineAccessTokens', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('refreshes only accounts returned by the active tenant account query', async () => {
    db.getActiveTenantLineAccounts.mockResolvedValue([{
      id: 'account-a',
      tenant_id: 'tenant-a',
      pharmacy_mode: 0,
      name: 'Pharmacy A',
      channel_id: 'channel-a',
      channel_secret: 'secret-a',
      is_active: 1,
      token_expires_at: null,
      updated_at: '2026-08-18T00:00:00.000Z',
    }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-token',
      expires_in: 2_592_000,
      token_type: 'Bearer',
    }), { status: 200 })));

    await refreshLineAccessTokens({} as D1Database);

    expect(db.getActiveTenantLineAccounts).toHaveBeenCalledOnce();
    expect(db.updateLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'account-a',
      expect.objectContaining({ channel_access_token: 'new-token' }),
    );
  });

  it('refreshes pharmacy tokens only through the encrypted tenant credential store', async () => {
    db.getActiveTenantLineAccounts.mockResolvedValue([{
      id: 'account-a',
      tenant_id: 'tenant-a',
      pharmacy_mode: 1,
      name: 'Pharmacy A',
      channel_id: 'channel-a',
      channel_secret: 'encrypted:v1',
      is_active: 1,
      token_expires_at: null,
      updated_at: '2026-08-18T00:00:00.000Z',
    }]);
    credentials.readLineCredential.mockResolvedValue('tenant-channel-secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-tenant-token',
      expires_in: 2_592_000,
      token_type: 'Bearer',
    }), { status: 200 })));

    await refreshLineAccessTokens({} as D1Database, {
      lineCredentialKey: 'synthetic-line-credential-root-key-v1',
    });

    expect(credentials.readLineCredential).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-key-v1',
      { tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret' },
    );
    expect(accounts.updateEncryptedLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-line-credential-root-key-v1',
      {
        tenantId: 'tenant-a',
        lineAccountId: 'account-a',
        expectedUpdatedAt: '2026-08-18T00:00:00.000Z',
        credentials: [{ kind: 'channel_access_token', credential: 'new-tenant-token' }],
        metadata: { tokenExpiresAt: expect.any(String) },
      },
    );
    expect(credentials.writeLineCredential).not.toHaveBeenCalled();
    expect(db.updateLineAccount).not.toHaveBeenCalled();
  });

  it('does not fall back to a plaintext pharmacy secret when the root key is unavailable', async () => {
    db.getActiveTenantLineAccounts.mockResolvedValue([{
      id: 'account-a',
      tenant_id: 'tenant-a',
      pharmacy_mode: 1,
      name: 'Pharmacy A',
      channel_id: 'channel-a',
      channel_secret: 'legacy-plaintext-must-not-be-used',
      is_active: 1,
      token_expires_at: null,
    }]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await refreshLineAccessTokens({} as D1Database);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updateLineAccount).not.toHaveBeenCalled();
    expect(credentials.writeLineCredential).not.toHaveBeenCalled();
  });

  it('stores the token expiry as UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    db.getActiveTenantLineAccounts.mockResolvedValue([{
      id: 'account-a',
      tenant_id: 'tenant-a',
      pharmacy_mode: 0,
      name: 'Pharmacy A',
      channel_id: 'channel-a',
      channel_secret: 'secret-a',
      is_active: 1,
      token_expires_at: null,
    }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    }), { status: 200 })));

    await refreshLineAccessTokens({} as D1Database);

    expect(db.updateLineAccount).toHaveBeenCalledWith(
      expect.anything(),
      'account-a',
      expect.objectContaining({ token_expires_at: '2026-08-18T13:00:00.000Z' }),
    );
  });

  it('does not log the upstream response body or account name when token issue fails', async () => {
    db.getActiveTenantLineAccounts.mockResolvedValue([{
      id: 'account-a',
      tenant_id: 'tenant-a',
      pharmacy_mode: 0,
      name: 'Sensitive Pharmacy Name',
      channel_id: 'channel-a',
      channel_secret: 'secret-a',
      is_active: 1,
      token_expires_at: null,
    }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('sensitive-upstream-detail', { status: 401 }),
    ));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await refreshLineAccessTokens({} as D1Database);

    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('line_token_refresh_failed');
    expect(logged).toContain('account-a');
    expect(logged).not.toContain('Sensitive Pharmacy Name');
    expect(logged).not.toContain('sensitive-upstream-detail');
    expect(db.updateLineAccount).not.toHaveBeenCalled();
  });
});
