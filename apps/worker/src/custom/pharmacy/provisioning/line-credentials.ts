const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const INVALID_LINE_CREDENTIAL_ERROR = 'Invalid LINE credential';
export const LINE_CREDENTIAL_KEY_VERSION = 1 as const;
export const LINE_CREDENTIAL_KINDS = [
  'channel_access_token',
  'channel_secret',
  'login_channel_secret',
] as const;

export type LineCredentialKind = typeof LINE_CREDENTIAL_KINDS[number];

export interface EncryptedLineCredential {
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  lookupDigest: string | null;
}

export interface EncryptLineCredentialInput {
  rootSecret: string;
  tenantId: string;
  lineAccountId: string;
  kind: LineCredentialKind;
  credential: string;
  keyVersion?: number;
}

export interface DecryptLineCredentialInput extends EncryptedLineCredential {
  rootSecret: string;
  tenantId: string;
  lineAccountId: string;
  kind: LineCredentialKind;
}

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_CREDENTIAL_BYTES = 2048;
const ROOT_SECRET_LABEL = 'line-credentials:v1';
const ACCESS_TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function invalid(): never {
  throw new Error(INVALID_LINE_CREDENTIAL_ERROR);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function fromBase64Url(value: unknown, expectedLength?: number, maxLength?: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 ||
      !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) invalid();
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (toBase64Url(bytes) !== value ||
        (expectedLength !== undefined && bytes.length !== expectedLength) ||
        (maxLength !== undefined && bytes.length > maxLength)) invalid();
    return bytes;
  } catch {
    invalid();
  }
}

function isLineCredentialKind(value: unknown): value is LineCredentialKind {
  return typeof value === 'string' &&
    (LINE_CREDENTIAL_KINDS as readonly string[]).includes(value);
}

function validateRootSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || encoder.encode(value).length < 32 || value.length > 4096) invalid();
}

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
      value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) invalid();
}

function validateContext(
  rootSecret: unknown,
  tenantId: unknown,
  lineAccountId: unknown,
  kind: unknown,
  keyVersion: unknown,
): asserts rootSecret is string {
  validateRootSecret(rootSecret);
  validateId(tenantId);
  validateId(lineAccountId);
  if (!isLineCredentialKind(kind) || keyVersion !== LINE_CREDENTIAL_KEY_VERSION) invalid();
}

function validateCredential(kind: LineCredentialKind, credential: unknown): asserts credential is string {
  if (typeof credential !== 'string' || credential.length < 32 || credential.length > MAX_CREDENTIAL_BYTES ||
      credential.trim() !== credential || /[\u0000-\u001F\u007F]/u.test(credential) ||
      encoder.encode(credential).length > MAX_CREDENTIAL_BYTES) invalid();
  if (kind === 'channel_secret' || kind === 'login_channel_secret') {
    if (credential.length > 128) invalid();
  }
}

function aad(
  tenantId: string,
  lineAccountId: string,
  kind: LineCredentialKind,
  keyVersion: number,
): Uint8Array {
  return encoder.encode(JSON.stringify({ tenantId, lineAccountId, kind, keyVersion }));
}

async function hmac(rootSecret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    asBuffer(encoder.encode(rootSecret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function encryptionKey(rootSecret: string, keyVersion: number): Promise<CryptoKey> {
  const material = await hmac(rootSecret, `${ROOT_SECRET_LABEL}:encryption:${keyVersion}`);
  return crypto.subtle.importKey('raw', asBuffer(material), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sameText(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function computeLineAccessTokenLookupDigest(
  rootSecret: string,
  credential: string,
): Promise<string> {
  try {
    validateRootSecret(rootSecret);
    validateCredential('channel_access_token', credential);
    return toHex(await hmac(
      rootSecret,
      `${ROOT_SECRET_LABEL}:lookup:channel_access_token:${credential}`,
    ));
  } catch {
    invalid();
  }
}

export async function encryptLineCredential(
  input: EncryptLineCredentialInput,
): Promise<EncryptedLineCredential> {
  try {
    const keyVersion = input.keyVersion ?? LINE_CREDENTIAL_KEY_VERSION;
    validateContext(input.rootSecret, input.tenantId, input.lineAccountId, input.kind, keyVersion);
    validateCredential(input.kind, input.credential);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aad(
        input.tenantId, input.lineAccountId, input.kind, keyVersion,
      )) },
      await encryptionKey(input.rootSecret, keyVersion),
      asBuffer(encoder.encode(input.credential)),
    );
    return {
      keyVersion,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(new Uint8Array(encrypted)),
      lookupDigest: input.kind === 'channel_access_token'
        ? await computeLineAccessTokenLookupDigest(input.rootSecret, input.credential)
        : null,
    };
  } catch {
    invalid();
  }
}

export async function decryptLineCredential(
  input: DecryptLineCredentialInput,
): Promise<string> {
  try {
    validateContext(
      input.rootSecret, input.tenantId, input.lineAccountId, input.kind, input.keyVersion,
    );
    const nonce = fromBase64Url(input.nonce, NONCE_BYTES);
    const ciphertext = fromBase64Url(input.ciphertext, undefined, MAX_CREDENTIAL_BYTES + AUTH_TAG_BYTES);
    if (ciphertext.length < AUTH_TAG_BYTES) {
      invalid();
    }
    if (input.kind === 'channel_access_token') {
      if (typeof input.lookupDigest !== 'string' ||
          !ACCESS_TOKEN_DIGEST_PATTERN.test(input.lookupDigest)) invalid();
    } else if (input.lookupDigest !== null) {
      invalid();
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBuffer(nonce), additionalData: asBuffer(aad(
        input.tenantId, input.lineAccountId, input.kind, input.keyVersion,
      )) },
      await encryptionKey(input.rootSecret, input.keyVersion),
      asBuffer(ciphertext),
    );
    const credential = decoder.decode(plaintext);
    validateCredential(input.kind, credential);
    if (input.kind === 'channel_access_token' &&
        !sameText(
          await computeLineAccessTokenLookupDigest(input.rootSecret, credential),
          input.lookupDigest as string,
        )) {
      invalid();
    }
    return credential;
  } catch {
    invalid();
  }
}
