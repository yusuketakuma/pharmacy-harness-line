import { afterEach, describe, expect, it, vi } from 'vitest';

const { getActiveTenantLineAccounts } = vi.hoisted(() => ({
  getActiveTenantLineAccounts: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({ getActiveTenantLineAccounts }));

import {
  verifyCallerLineIdentity,
  verifyCallerLineUserId,
} from './liff-auth.js';

const env = {
  LINE_LOGIN_CHANNEL_ID: 'default-channel',
  DB: {} as D1Database,
};

type LoginAccount = {
  id: string;
  tenant_id: string;
  login_channel_id: string;
  liff_id?: string | null;
};

function idToken(audience: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ aud: audience })}.signature`;
}

function envWith(accounts: LoginAccount[]) {
  getActiveTenantLineAccounts.mockResolvedValue(accounts);
  const DB = {
    prepare() {
      return {
        bind(audience: string) {
          return {
            all: async () => ({
              results: accounts.filter((account) => account.login_channel_id === audience),
            }),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { ...env, DB };
}

afterEach(() => {
  vi.restoreAllMocks();
  getActiveTenantLineAccounts.mockReset();
});

describe('verifyCallerLineIdentity', () => {
  it('returns the LINE user and exact channel that verified the token', async () => {
    const accounts = [
      {
        id: 'account-1',
        tenant_id: 'tenant-1',
        login_channel_id: 'account-channel',
      },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sub: 'U123', aud: 'account-channel' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      verifyCallerLineIdentity(`Bearer ${idToken('account-channel')}`, envWith(accounts)),
    ).resolves.toEqual({
      lineUserId: 'U123',
      loginChannelId: 'account-channel',
      lineAccountId: 'account-1',
      tenantId: 'tenant-1',
    });
  });

  it('rejects missing bearer credentials without querying accounts', async () => {
    await expect(verifyCallerLineIdentity(undefined, env)).resolves.toBeNull();
    expect(getActiveTenantLineAccounts).not.toHaveBeenCalled();
  });

  it('keeps the existing user-id helper as a compatibility wrapper', async () => {
    const accounts = [{
      id: 'account-default',
      tenant_id: 'tenant-default',
      login_channel_id: 'default-channel',
    }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sub: 'U456', aud: 'default-channel' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      verifyCallerLineUserId(`Bearer ${idToken('default-channel')}`, envWith(accounts)),
    ).resolves.toBe('U456');
  });

  it('rejects the environment default channel when it is not mapped to an active tenant', async () => {
    getActiveTenantLineAccounts.mockResolvedValue([]);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      verifyCallerLineIdentity('Bearer token', env),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('selects the audience account before calling LINE, regardless of tenant count', async () => {
    const accounts = Array.from({ length: 100 }, (_, index) => ({
      id: `account-${index}`,
      tenant_id: `tenant-${index}`,
      login_channel_id: `channel-${index}`,
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const clientId = new URLSearchParams(String(init?.body)).get('client_id');
      return clientId === 'channel-99'
        ? new Response(JSON.stringify({ sub: 'U999', aud: 'channel-99' }), { status: 200 })
        : new Response('{}', { status: 400 });
    });

    await expect(
      verifyCallerLineIdentity(`Bearer ${idToken('channel-99')}`, envWith(accounts)),
    ).resolves.toMatchObject({ lineAccountId: 'account-99', tenantId: 'tenant-99' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a LINE response whose audience does not match the selected channel', async () => {
    const accounts = [{
      id: 'account-1', tenant_id: 'tenant-1', login_channel_id: 'channel-1',
    }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sub: 'U123', aud: 'other-channel' }), { status: 200 }),
    );

    await expect(
      verifyCallerLineIdentity(`Bearer ${idToken('channel-1')}`, envWith(accounts)),
    ).resolves.toBeNull();
  });

  it('rejects malformed tokens before D1 or LINE lookup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(verifyCallerLineIdentity('Bearer not-a-jwt', env)).resolves.toBeNull();
    expect(getActiveTenantLineAccounts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
