import { describe, expect, test } from 'vitest';
import { verifySignature } from '../src/webhook.js';

const channelSecret = 'test-channel-secret';
const body = '{"events":[]}';

async function computeValidSignature(): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function flipLastChar(value: string): string {
  const last = value.at(-1);
  return value.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

describe('verifySignature', () => {
  test('accepts the correct HMAC-SHA256 signature', async () => {
    const validSignature = await computeValidSignature();
    await expect(verifySignature(channelSecret, body, validSignature)).resolves.toBe(true);
  });

  test('rejects a same-length signature that differs by one character', async () => {
    const validSignature = await computeValidSignature();
    const tampered = flipLastChar(validSignature);
    expect(tampered).toHaveLength(validSignature.length);
    expect(tampered).not.toBe(validSignature);
    await expect(verifySignature(channelSecret, body, tampered)).resolves.toBe(false);
  });

  test('rejects a different-length signature', async () => {
    const validSignature = await computeValidSignature();
    await expect(verifySignature(channelSecret, body, validSignature.slice(0, -1))).resolves.toBe(false);
    await expect(verifySignature(channelSecret, body, '')).resolves.toBe(false);
  });
});
