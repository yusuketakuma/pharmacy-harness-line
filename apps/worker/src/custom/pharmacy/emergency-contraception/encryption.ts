const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EmergencyEncryptionContext {
  tenantId: string;
  lineAccountId: string;
  friendId: string;
  intakeId: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function validateContext(context: EmergencyEncryptionContext): void {
  if (Object.values(context).some((value) => !value || value.length > 160)) {
    throw new Error('encrypted intake is invalid');
  }
}

async function key(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('encryption key is not configured');
  const material = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`pharmacy-emergency-intake:v1:${secret}`),
  );
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function additionalData(context: EmergencyEncryptionContext): Uint8Array {
  return encoder.encode(JSON.stringify(context));
}

export async function sealEmergencyPayload(
  payload: Record<string, unknown>,
  secret: string,
  context: EmergencyEncryptionContext,
): Promise<string> {
  validateContext(context);
  const plaintext = encoder.encode(JSON.stringify(payload));
  if (plaintext.length > 2048) throw new Error('encrypted intake is invalid');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(context) },
    await key(secret),
    plaintext,
  );
  return `v1.${encodeBase64Url(nonce)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openEmergencyPayload(
  value: string,
  secret: string,
  context: EmergencyEncryptionContext,
): Promise<Record<string, unknown>> {
  validateContext(context);
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('encrypted intake is invalid');
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64Url(parts[1]),
        additionalData: additionalData(context),
      },
      await key(secret),
      decodeBase64Url(parts[2]),
    );
    const parsed = JSON.parse(decoder.decode(plaintext));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === 'encryption key is not configured') throw error;
    throw new Error('encrypted intake is invalid');
  }
}
