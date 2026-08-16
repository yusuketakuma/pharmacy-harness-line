import { describe, expect, it } from 'vitest';
import { inspectPrescriptionImage } from './image.js';

describe('inspectPrescriptionImage', () => {
  it.each([
    ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0x00])],
    ['image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])('accepts %s only when its magic bytes match', async (contentType, bytes) => {
    const result = await inspectPrescriptionImage(contentType, bytes);
    expect(result.byteSize).toBe(bytes.byteLength);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a declared type that does not match the bytes', async () => {
    await expect(
      inspectPrescriptionImage('image/png', new Uint8Array([0xff, 0xd8, 0xff])),
    ).rejects.toThrow('content type does not match image bytes');
  });

  it('rejects unsupported and empty images', async () => {
    await expect(
      inspectPrescriptionImage('image/gif', new Uint8Array([0x47, 0x49, 0x46])),
    ).rejects.toThrow('unsupported image content type');
    await expect(
      inspectPrescriptionImage('image/png', new Uint8Array()),
    ).rejects.toThrow('image is empty');
  });

  it('rejects images over 10 MiB', async () => {
    await expect(
      inspectPrescriptionImage('image/jpeg', new Uint8Array(10 * 1024 * 1024 + 1)),
    ).rejects.toThrow('image exceeds 10 MiB');
  });
});
