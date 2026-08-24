export function r2ChecksumHex(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^[0-9a-f]{64}$/iu.test(value) ? value.toLowerCase() : null;
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

/** Store an immutable key, accepting only an idempotent retry of the same bytes. */
export async function putR2ObjectOnce(
  bucket: R2Bucket,
  key: string,
  value: ArrayBuffer | ArrayBufferView,
  options: R2PutOptions,
  expectedSha256: string,
): Promise<boolean> {
  const stored = await bucket.put(key, value, {
    ...options,
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (stored) return true;
  const existing = await bucket.head(key);
  return r2ChecksumHex(existing?.checksums?.sha256) === expectedSha256.toLowerCase();
}

export const R2_RETENTION_TOMBSTONE = 'pharmacy-retention-v1';

export function isR2RetentionTombstone(object: R2Object | null): boolean {
  return object?.customMetadata?.retentionDisposition === R2_RETENTION_TOMBSTONE;
}

/** Atomically erase the selected bytes while permanently retiring their key. */
export async function putR2RetentionTombstone(
  bucket: R2Bucket,
  key: string,
  expectedEtag: string,
): Promise<boolean> {
  // ponytail: zero-byte tombstones stay permanent; use versioned retired-key records if volume matters.
  return Boolean(await bucket.put(key, null, {
    onlyIf: { etagMatches: expectedEtag },
    customMetadata: { retentionDisposition: R2_RETENTION_TOMBSTONE },
  }));
}
