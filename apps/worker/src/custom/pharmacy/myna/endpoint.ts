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

async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('Myna endpoint encryption key is not configured');
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
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

export async function encryptEndpointUrl(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    textEncoder.encode(value),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

export async function decryptEndpointUrl(value: string, secret: string): Promise<string> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('invalid encrypted endpoint URL');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(parts[1]) },
      await encryptionKey(secret),
      base64UrlDecode(parts[2]),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('invalid encrypted endpoint URL');
  }
}
