import { afterEach, describe, expect, it, vi } from 'vitest';

const { getLineAccounts } = vi.hoisted(() => ({
  getLineAccounts: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({ getLineAccounts }));

import {
  verifyCallerLineIdentity,
  verifyCallerLineUserId,
} from './liff-auth.js';

const env = {
  LINE_LOGIN_CHANNEL_ID: 'default-channel',
  DB: {} as D1Database,
};

afterEach(() => {
  vi.restoreAllMocks();
  getLineAccounts.mockReset();
});

describe('verifyCallerLineIdentity', () => {
  it('returns the LINE user and exact channel that verified the token', async () => {
    getLineAccounts.mockResolvedValue([
      { login_channel_id: 'account-channel' },
    ]);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sub: 'U123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await expect(
      verifyCallerLineIdentity('Bearer token', env),
    ).resolves.toEqual({
      lineUserId: 'U123',
      loginChannelId: 'account-channel',
    });
  });

  it('rejects missing bearer credentials without querying accounts', async () => {
    await expect(verifyCallerLineIdentity(undefined, env)).resolves.toBeNull();
    expect(getLineAccounts).not.toHaveBeenCalled();
  });

  it('keeps the existing user-id helper as a compatibility wrapper', async () => {
    getLineAccounts.mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sub: 'U456' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      verifyCallerLineUserId('Bearer token', env),
    ).resolves.toBe('U456');
  });
});
