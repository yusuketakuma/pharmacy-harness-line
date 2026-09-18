// Compatibility helpers for older WebView engines bundled inside LINE.
// crypto.randomUUID / structuredClone are missing on some shipped versions;
// crashing at mount is worse than a fallback for these call sites.

/** RFC4122 v4 id. Falls back to getRandomValues, then to time+random —
 *  adequate for idempotency keys (per-device uniqueness, retried safely). */
export function pharmacyUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = cryptoApi?.getRandomValues?.(new Uint8Array(16));
  if (bytes) {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Deep clone of JSON-shaped values. structuredClone throws on non-cloneable
 *  input and is absent on older engines; the values cloned here are plain
 *  JSON (drafts, request bodies) so a JSON round-trip is a safe fallback. */
export function cloneJsonValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fall through to the JSON fallback
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
