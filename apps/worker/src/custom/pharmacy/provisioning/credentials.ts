const encoder = new TextEncoder();
// ponytail: Cloudflare Workers caps PBKDF2 at 100k; raise only when the runtime supports it.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export function generateTemporaryPassword(): string {
  return `Tmp-${toBase64Url(crypto.getRandomValues(new Uint8Array(18)))}`;
}

export function isValidAdminPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 128 && password.trim().length > 0;
}

export async function hashTenantPassword(password: string): Promise<string> {
  if (!isValidAdminPassword(password)) throw new Error('Password must be 12 to 128 characters');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePassword(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyTenantPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltRaw, hashRaw, ...rest] = encoded.split('$');
  const iterations = Number.parseInt(iterationsRaw ?? '', 10);
  const salt = saltRaw ? fromBase64Url(saltRaw) : null;
  const expected = hashRaw ? fromBase64Url(hashRaw) : null;
  if (rest.length > 0 || algorithm !== 'pbkdf2-sha256' ||
      !Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000 ||
      !salt || salt.length !== SALT_BYTES || !expected || expected.length !== HASH_BYTES) {
    return false;
  }
  const actual = await derivePassword(password, salt, iterations);
  return sameBytes(actual, expected);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateTenantAdminSessionToken(): string {
  return `tas_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function isTenantAdminSessionToken(token: string): boolean {
  return /^tas_[A-Za-z0-9_-]{43}$/u.test(token);
}

export async function hashTenantAdminSessionToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}
