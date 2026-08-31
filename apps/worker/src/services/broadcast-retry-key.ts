/**
 * Produce a stable RFC 4122 UUID-shaped retry key from the logical delivery.
 * LINE accepts a retry of the same push/multicast without delivering it twice
 * when the same X-Line-Retry-Key is reused.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isLineRetryKey(value: string): boolean {
  return UUID_RE.test(value);
}

export async function createLineRetryKey(value: string): Promise<string> {
  if (isLineRetryKey(value)) return value.toLowerCase();
  const input = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createBroadcastRetryKey(...parts: string[]): Promise<string> {
  return createLineRetryKey(`line-harness:broadcast:${parts.join('\u001f')}`);
}

export function createFormLinkRetryKey(params: {
  friendId: string;
  formId: string;
  ref: string;
  gate: string;
  xh: string;
}): Promise<string> {
  return createBroadcastRetryKey(
    'liff-form-link', params.friendId, params.formId, params.ref, params.gate, params.xh,
  );
}
