const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Legacy v1: SHA-256(secret) as key, no AAD. Read-only; new values are written as v2. */
async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Myna endpoint encryption key is not configured');
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const KEY_VERSION = 2;

/** AAD binds the ciphertext to the owning account so a row copied across accounts cannot be decrypted. */
export interface EndpointCryptoScope {
  lineAccountId: string;
}

function aad(scope: EndpointCryptoScope): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    lineAccountId: scope.lineAccountId, purpose: 'myna-endpoint', keyVersion: KEY_VERSION,
  }));
}

/** v2 key: HMAC(secret, label:keyVersion), same derivation shape as the LINE credential store. */
async function derivedKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Myna endpoint encryption key is not configured');
  const hmacKey = await crypto.subtle.importKey(
    'raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const material = await crypto.subtle.sign(
    'HMAC', hmacKey, textEncoder.encode(`myna-endpoint:encryption:${KEY_VERSION}`),
  );
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function normalizeEndpointUrl(value: string, allowedHosts: string[]): string {
  try {
    const url = new URL(value.trim());
    const hosts = new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
    if (
      url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
      !url.hostname || !hosts.has(url.hostname.toLowerCase())
    ) throw new Error('invalid Myna endpoint URL');
    return url.toString();
  } catch {
    throw new Error('invalid Myna endpoint URL');
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ponytail: scope is optional only until endpoint-repository.ts passes its
// lineAccountId; without a scope the legacy v1 format (no AAD) is written.
export async function encryptEndpointUrl(
  value: string,
  secret: string,
  scope?: EndpointCryptoScope,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    scope ? { name: 'AES-GCM', iv, additionalData: aad(scope) } : { name: 'AES-GCM', iv },
    scope ? await derivedKey(secret) : await encryptionKey(secret),
    textEncoder.encode(value),
  );
  return `${scope ? 'v2' : 'v1'}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

export async function decryptEndpointUrl(
  value: string,
  secret: string,
  scope?: EndpointCryptoScope,
): Promise<string> {
  const parts = value.split('.');
  const version = parts[0];
  if (parts.length !== 3 || (version !== 'v1' && version !== 'v2')) {
    throw new Error('invalid encrypted endpoint URL');
  }
  if (version === 'v2' && !scope) throw new Error('invalid encrypted endpoint URL');
  try {
    const iv = base64UrlDecode(parts[1]);
    const plaintext = await crypto.subtle.decrypt(
      version === 'v2' ? { name: 'AES-GCM', iv, additionalData: aad(scope!) } : { name: 'AES-GCM', iv },
      version === 'v2' ? await derivedKey(secret) : await encryptionKey(secret),
      base64UrlDecode(parts[2]),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('invalid encrypted endpoint URL');
  }
}
