const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Strict canonical base64url decode. Returns null for malformed or
 * non-canonical input; callers decide how to map rejection to their
 * domain error.
 */
export function decodeBase64Url(
  value: unknown,
  expectedLength?: number,
  maxLength?: number,
): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 ||
      !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (toBase64Url(bytes) !== value ||
        (expectedLength !== undefined && bytes.length !== expectedLength) ||
        (maxLength !== undefined && bytes.length > maxLength)) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Lenient base64url decode that throws on invalid input (atob semantics). */
export function decodeBase64UrlLenient(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** Constant-time comparison that scans both strings fully (no length early-return). */
export function sameText(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Constant-time comparison for fixed-length byte values. */
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', asBuffer(encoder.encode(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, asBuffer(encoder.encode(value))));
}

/** Derives an AES-GCM key as HMAC(secret, label), the shared KDF shape. */
export async function deriveAesGcmKey(secret: string, label: string): Promise<CryptoKey> {
  const material = await hmacSha256(secret, label);
  return crypto.subtle.importKey('raw', asBuffer(material), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Derives an HMAC-SHA256 sign/verify key as HMAC(secret, label). */
export async function deriveHmacKey(secret: string, label: string): Promise<CryptoKey> {
  const material = await hmacSha256(secret, label);
  return crypto.subtle.importKey(
    'raw', asBuffer(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

export function isValidRootSecret(value: unknown): value is string {
  return typeof value === 'string' && encoder.encode(value).length >= 32 && value.length <= 4096;
}
