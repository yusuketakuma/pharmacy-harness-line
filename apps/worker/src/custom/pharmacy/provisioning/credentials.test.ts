import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateTemporaryPassword,
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isTenantAdminSessionToken,
  verifyTenantPassword,
} from './credentials.js';

describe('tenant admin credentials', () => {
  afterEach(() => vi.restoreAllMocks());
  it('stores a salted password hash and verifies only the original password', async () => {
    const hash = await hashTenantPassword('Correct horse battery 42');

    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(hash).not.toContain('Correct horse battery 42');
    await expect(verifyTenantPassword('Correct horse battery 42', hash)).resolves.toBe(true);
    await expect(verifyTenantPassword('wrong password', hash)).resolves.toBe(false);
    await expect(verifyTenantPassword('Correct horse battery 42', 'invalid')).resolves.toBe(false);
  });

  it('issues a high-entropy temporary password without persisting it', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const bytes = array as Uint8Array;
      bytes.forEach((_, index) => { bytes[index] = index + 1; });
      return array;
    });

    expect(generateTemporaryPassword()).toMatch(/^Tmp-[A-Za-z0-9_-]{24}$/);
  });

  it('stores only a one-way hash of a high-entropy opaque session token', async () => {
    const token = generateTenantAdminSessionToken();
    const hash = await hashTenantAdminSessionToken(token);

    expect(isTenantAdminSessionToken(token)).toBe(true);
    expect(token).toMatch(/^tas_[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(isTenantAdminSessionToken(`${token}x`)).toBe(false);
  });
});
