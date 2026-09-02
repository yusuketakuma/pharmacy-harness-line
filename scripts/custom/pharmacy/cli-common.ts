import { randomBytes, randomUUID } from 'node:crypto';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

export function requestId(values: Record<string, string>): string {
  const supplied = values['idempotency-key']?.trim();
  if (supplied && !IDEMPOTENCY_KEY_PATTERN.test(supplied)) {
    throw new Error('--idempotency-key must be 8 to 128 ASCII characters');
  }
  return supplied || randomUUID();
}

// Random per run and never derived from a platform secret or printed replay key.
export function temporaryPassword(): string {
  return `Tmp-${randomBytes(24).toString('base64url')}`;
}

export function workerOrigin(raw: string): string {
  const worker = new URL(raw);
  if ((worker.protocol !== 'https:' && worker.hostname !== 'localhost') ||
      worker.username || worker.password || worker.search || worker.hash) {
    throw new Error('--worker-url must be an HTTPS origin');
  }
  return worker.origin;
}

export function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value
    ? value.replace(/[\u0000-\u001F\u007F]/gu, ' ').slice(0, 300)
    : fallback;
}
