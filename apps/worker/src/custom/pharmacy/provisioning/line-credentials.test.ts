import { describe, expect, it } from 'vitest';
import {
  computeLineAccessTokenLookupDigest,
  decryptLineCredential,
  encryptLineCredential,
  INVALID_LINE_CREDENTIAL_ERROR,
} from './line-credentials.js';

const ROOT_SECRET = 'synthetic-root-secret-for-tests-v1';
const TENANT_ID = 'tenant-a';
const ACCOUNT_ID = 'account-a';
const ACCESS_TOKEN = `token-${'a'.repeat(64)}`;
const CHANNEL_SECRET = 'a'.repeat(32);

describe('LINE credential encryption', () => {
  it.each([
    ['channel_access_token', ACCESS_TOKEN],
    ['channel_secret', CHANNEL_SECRET],
    ['login_channel_secret', CHANNEL_SECRET],
  ] as const)('round-trips %s without storing plaintext', async (kind, credential) => {
    const encrypted = await encryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind,
      credential,
    });

    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    expect(encrypted.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encrypted.ciphertext).not.toContain(credential);
    if (kind === 'channel_access_token') {
      expect(encrypted.lookupDigest).toMatch(/^[0-9a-f]{64}$/u);
    } else {
      expect(encrypted.lookupDigest).toBeNull();
    }

    await expect(decryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind,
      ...encrypted,
    })).resolves.toBe(credential);
  });

  it('uses a fresh nonce for each encryption', async () => {
    const input = {
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token' as const,
      credential: ACCESS_TOKEN,
    };
    const first = await encryptLineCredential(input);
    const second = await encryptLineCredential(input);

    expect(second.nonce).not.toBe(first.nonce);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });

  it('fails closed for a different tenant, account, kind, key version, root, or tampered ciphertext', async () => {
    const encrypted = await encryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      credential: ACCESS_TOKEN,
    });
    const base = {
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token' as const,
      ...encrypted,
    };
    const cases = [
      { tenantId: 'tenant-b' },
      { lineAccountId: 'account-b' },
      { kind: 'channel_secret' as const },
      { keyVersion: 2 },
      { rootSecret: 'different-root-secret-v1' },
      {
        ciphertext: `${encrypted.ciphertext.slice(0, -1)}${encrypted.ciphertext.endsWith('A') ? 'B' : 'A'}`,
      },
    ];

    for (const override of cases) {
      await expect(decryptLineCredential({ ...base, ...override } as Parameters<typeof decryptLineCredential>[0]))
        .rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
    }
  });

  it('rejects malformed encoding, empty IDs, and invalid credential lengths', async () => {
    const encrypted = await encryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      credential: ACCESS_TOKEN,
    });

    await expect(decryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      ...encrypted,
      nonce: `${encrypted.nonce}=`,
    })).rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
    await expect(decryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      ...encrypted,
      ciphertext: 'A',
    })).rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
    await expect(encryptLineCredential({
      rootSecret: 'too-short',
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      credential: ACCESS_TOKEN,
    })).rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
    await expect(encryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: '',
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      credential: ACCESS_TOKEN,
    })).rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
    await expect(encryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_access_token',
      credential: 'short',
    })).rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
    await expect(encryptLineCredential({
      rootSecret: ROOT_SECRET,
      tenantId: TENANT_ID,
      lineAccountId: ACCOUNT_ID,
      kind: 'channel_secret',
      credential: 'not-a-32-byte-secret',
    })).rejects.toThrow(INVALID_LINE_CREDENTIAL_ERROR);
  });

  it('computes a deterministic keyed digest for access-token lookup', async () => {
    const first = await computeLineAccessTokenLookupDigest(ROOT_SECRET, ACCESS_TOKEN);
    const second = await computeLineAccessTokenLookupDigest(ROOT_SECRET, ACCESS_TOKEN);
    const differentToken = await computeLineAccessTokenLookupDigest(ROOT_SECRET, `${ACCESS_TOKEN}x`);
    const differentRoot = await computeLineAccessTokenLookupDigest(
      'other-synthetic-root-secret-for-tests-v1',
      ACCESS_TOKEN,
    );

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
    expect(differentToken).not.toBe(first);
    expect(differentRoot).not.toBe(first);
  });
});
