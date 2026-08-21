import { describe, expect, it } from 'vitest';
import {
  decryptEndpointUrl,
  encryptEndpointUrl,
  normalizeEndpointUrl,
} from './endpoint.js';

describe('Myna endpoint protection', () => {
  it('accepts only HTTPS URLs on the configured host allowlist', () => {
    expect(normalizeEndpointUrl(
      'https://myna.example.test/pharmacy/abc', ['myna.example.test'],
    )).toBe('https://myna.example.test/pharmacy/abc');
    expect(() => normalizeEndpointUrl(
      'http://myna.example.test/pharmacy/abc', ['myna.example.test'],
    )).toThrow('invalid Myna endpoint URL');
    expect(() => normalizeEndpointUrl(
      'https://evil.example.test/pharmacy/abc', ['myna.example.test'],
    )).toThrow('invalid Myna endpoint URL');
    expect(() => normalizeEndpointUrl(
      'https://user:pass@myna.example.test/pharmacy/abc', ['myna.example.test'],
    )).toThrow('invalid Myna endpoint URL');
  });

  it('encrypts endpoint URLs at rest and decrypts only with the same secret', async () => {
    const encrypted = await encryptEndpointUrl(
      'https://myna.example.test/pharmacy/abc', 'test-secret',
    );
    expect(encrypted).not.toContain('myna.example.test');
    await expect(decryptEndpointUrl(encrypted, 'test-secret'))
      .resolves.toBe('https://myna.example.test/pharmacy/abc');
    await expect(decryptEndpointUrl(encrypted, 'other-secret')).rejects.toThrow();
  });

  it('binds v2 ciphertext to the owning account and still reads legacy v1 values', async () => {
    const url = 'https://myna.example.test/pharmacy/abc';
    const scope = { lineAccountId: 'account-a' };
    const encrypted = await encryptEndpointUrl(url, 'test-secret', scope);
    expect(encrypted.startsWith('v2.')).toBe(true);
    await expect(decryptEndpointUrl(encrypted, 'test-secret', scope)).resolves.toBe(url);
    await expect(decryptEndpointUrl(encrypted, 'test-secret', { lineAccountId: 'account-b' }))
      .rejects.toThrow('invalid encrypted endpoint URL');
    await expect(decryptEndpointUrl(encrypted, 'test-secret')).rejects.toThrow();

    const legacy = await encryptEndpointUrl(url, 'test-secret');
    expect(legacy.startsWith('v1.')).toBe(true);
    await expect(decryptEndpointUrl(legacy, 'test-secret', scope)).resolves.toBe(url);
  });
});
