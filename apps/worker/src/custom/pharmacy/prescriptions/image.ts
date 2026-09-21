export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const signatures: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

export async function inspectPrescriptionImage(
  contentType: string,
  bytes: Uint8Array,
): Promise<{ byteSize: number; sha256: string }> {
  const signature = signatures[contentType];
  if (!signature) throw new Error('unsupported image content type');
  if (bytes.byteLength === 0) throw new Error('image is empty');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('image exceeds 10 MiB');
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('content type does not match image bytes');
  }

  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return {
    byteSize: bytes.byteLength,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  };
}


/** Read at most the accepted image size; null means the body exceeded it. */
export async function readPrescriptionImageBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
