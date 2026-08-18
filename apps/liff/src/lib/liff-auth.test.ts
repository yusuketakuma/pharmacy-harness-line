import { beforeEach, describe, expect, it, vi } from 'vitest';

const liff = vi.hoisted(() => ({
  init: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  login: vi.fn(),
  getProfile: vi.fn(async () => ({ userId: 'U-patient' })),
  getIDToken: vi.fn((): string | null => 'verified-by-worker'),
}));

vi.mock('@line/liff', () => ({ default: liff }));

const { getIdToken, getLiffId, getLineUserId, initLiff } = await import('./liff-auth.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_DEFAULT_LIFF_ID', 'default-tenant-liff');
});

describe('central pharmacy LIFF initialization', () => {
  it('fails closed instead of using a build-time default tenant', async () => {
    vi.stubGlobal('window', { location: { href: 'https://liff.example.test/pharmacy/receive' } });

    await expect(initLiff()).rejects.toThrow('liffId not provided');
    expect(liff.init).not.toHaveBeenCalled();
  });

  it('uses only the LIFF ID carried by the tenant entry URL', async () => {
    vi.stubGlobal('window', {
      location: { href: 'https://liff.example.test/pharmacy/receive?liffId=tenant-a-liff' },
    });

    await initLiff();

    expect(liff.init).toHaveBeenCalledWith({ liffId: 'tenant-a-liff' });
    expect(getLiffId()).toBe('tenant-a-liff');
    expect(getLineUserId()).toBe('U-patient');
    expect(getIdToken()).toBe('verified-by-worker');
  });

  it('stops initialization while LINE login is redirecting', async () => {
    liff.isLoggedIn.mockReturnValueOnce(false);
    const href = 'https://liff.example.test/pharmacy/receive?liffId=tenant-a-liff';
    vi.stubGlobal('window', { location: { href } });

    await expect(initLiff()).resolves.toBe(false);
    expect(liff.login).toHaveBeenCalledWith({ redirectUri: href });
    expect(liff.getProfile).not.toHaveBeenCalled();
    expect(liff.getIDToken).not.toHaveBeenCalled();
  });

  it('does not render the pharmacy app when LINE cannot provide an ID token', async () => {
    liff.getIDToken.mockReturnValueOnce(null);
    vi.stubGlobal('window', {
      location: { href: 'https://liff.example.test/pharmacy/receive?liffId=tenant-a-liff' },
    });

    await expect(initLiff()).rejects.toThrow('id_token');
  });
});
