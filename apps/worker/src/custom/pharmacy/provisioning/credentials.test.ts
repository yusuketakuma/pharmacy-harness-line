import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateTemporaryPassword,
  generateTenantAdminSessionToken,
  hashTenantAdminSessionToken,
  hashTenantPassword,
  isValidAdminPassword,
  isTenantAdminSessionToken,
  verifyTenantPassword,
} from './credentials.js';
import { COMMON_PASSWORDS_TEXT } from './common-passwords.generated.js';

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

  it('requires 15 Unicode code points for a password-only administrator', () => {
    expect(isValidAdminPassword('12345678901234')).toBe(false);
    expect(isValidAdminPassword('123456789012345')).toBe(true);
    expect(isValidAdminPassword('薬'.repeat(15))).toBe(true);
    expect(isValidAdminPassword('a'.repeat(129))).toBe(false);
  });

  it('rejects a length-valid password from the versioned top-100k blocklist', () => {
    const corpus = COMMON_PASSWORDS_TEXT.split('\n');
    expect(corpus).toHaveLength(100_000);
    expect(new Set(corpus).size).toBe(100_000);
    expect(isValidAdminPassword('passwordpassword')).toBe(false);
    expect(isValidAdminPassword('Correct horse battery 42')).toBe(true);
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
