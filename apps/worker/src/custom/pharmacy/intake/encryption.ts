const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const INVALID_PATIENT_INTAKE_ENVELOPE_ERROR = 'Invalid patient intake envelope';
export const PATIENT_INTAKE_ENVELOPE_VERSION = 1 as const;
export const PATIENT_INTAKE_KEY_VERSION = 1 as const;
export const PATIENT_INTAKE_ENCRYPTED_FIELDS = [
  'patient_snapshot_json',
  'answers_json',
] as const;

export type PatientIntakeEncryptedField = typeof PATIENT_INTAKE_ENCRYPTED_FIELDS[number];

export interface PatientIntakeEncryptionContext {
  tenantId: string;
  lineAccountId: string;
  ownerFriendId: string;
  patientId: string;
  responseId: string;
  schemaVersion: number;
  sourceRevision: number;
  fieldName: PatientIntakeEncryptedField;
  envelopeVersion: number;
  keyVersion: number;
}

export interface PatientIntakeEncryptedEnvelope {
  envelopeVersion: number;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
}

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 65536;
const ROOT_SECRET_LABEL = 'pharmacy-patient-intake:v1';

function invalid(): never {
  throw new Error(INVALID_PATIENT_INTAKE_ENVELOPE_ERROR);
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
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

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 ||
      value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) invalid();
}

function validateRootSecret(value: unknown): asserts value is string {
  if (typeof value !== 'string' || encoder.encode(value).length < 32 || value.length > 4096) invalid();
}

function validateContext(context: PatientIntakeEncryptionContext): void {
  validateId(context.tenantId);
  validateId(context.lineAccountId);
  validateId(context.ownerFriendId);
  validateId(context.patientId);
  validateId(context.responseId);
  if (!Number.isSafeInteger(context.schemaVersion) || context.schemaVersion < 1 ||
      !Number.isSafeInteger(context.sourceRevision) || context.sourceRevision < 1 ||
      context.envelopeVersion !== PATIENT_INTAKE_ENVELOPE_VERSION ||
      context.keyVersion !== PATIENT_INTAKE_KEY_VERSION ||
      !(PATIENT_INTAKE_ENCRYPTED_FIELDS as readonly string[]).includes(context.fieldName)) invalid();
}

function validatePlaintext(value: unknown): asserts value is string {
  if (typeof value !== 'string') invalid();
  const bytes = encoder.encode(value);
  if (bytes.length < 2 || bytes.length > MAX_PLAINTEXT_BYTES) invalid();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  } catch {
    invalid();
  }
}

function additionalData(context: PatientIntakeEncryptionContext): Uint8Array {
  return encoder.encode(JSON.stringify({
    tenantId: context.tenantId,
    lineAccountId: context.lineAccountId,
    ownerFriendId: context.ownerFriendId,
    patientId: context.patientId,
    responseId: context.responseId,
    schemaVersion: context.schemaVersion,
    sourceRevision: context.sourceRevision,
    fieldName: context.fieldName,
    envelopeVersion: context.envelopeVersion,
    keyVersion: context.keyVersion,
  }));
}

async function encryptionKey(rootSecret: string, keyVersion: number): Promise<CryptoKey> {
  const hmacKey = await crypto.subtle.importKey(
    'raw', asBuffer(encoder.encode(rootSecret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const material = new Uint8Array(await crypto.subtle.sign(
    'HMAC', hmacKey, encoder.encode(`${ROOT_SECRET_LABEL}:encryption:${keyVersion}`),
  ));
  return crypto.subtle.importKey('raw', asBuffer(material), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealPatientIntakeField(
  plaintext: string,
  rootSecret: string,
  context: PatientIntakeEncryptionContext,
): Promise<PatientIntakeEncryptedEnvelope> {
  try {
    validateRootSecret(rootSecret);
    validateContext(context);
    validatePlaintext(plaintext);
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM', iv: asBuffer(nonce),
        additionalData: asBuffer(additionalData(context)),
      },
      await encryptionKey(rootSecret, context.keyVersion),
      asBuffer(encoder.encode(plaintext)),
    );
    return {
      envelopeVersion: context.envelopeVersion,
      keyVersion: context.keyVersion,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    };
  } catch {
    invalid();
  }
}

export async function openPatientIntakeField(
  envelope: PatientIntakeEncryptedEnvelope,
  rootSecret: string,
  context: PatientIntakeEncryptionContext,
): Promise<string> {
  try {
    validateRootSecret(rootSecret);
    validateContext(context);
    if (envelope.envelopeVersion !== context.envelopeVersion ||
        envelope.keyVersion !== context.keyVersion) invalid();
    const nonce = fromBase64Url(envelope.nonce, NONCE_BYTES);
    const ciphertext = fromBase64Url(
      envelope.ciphertext, undefined, MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES,
    );
    if (ciphertext.length <= AUTH_TAG_BYTES) invalid();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM', iv: asBuffer(nonce),
        additionalData: asBuffer(additionalData(context)),
      },
      await encryptionKey(rootSecret, context.keyVersion),
      asBuffer(ciphertext),
    );
    const decoded = decoder.decode(plaintext);
    validatePlaintext(decoded);
    return decoded;
  } catch {
    invalid();
  }
}
