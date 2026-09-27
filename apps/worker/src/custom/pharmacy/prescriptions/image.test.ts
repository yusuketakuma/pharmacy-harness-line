import { describe, expect, it } from 'vitest';
import { inspectPrescriptionImage, MAX_IMAGE_BYTES, readPrescriptionImageBody } from './image.js';

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
    await expect(inspectPrescriptionImage('image/png', new Uint8Array([0xff, 0xd8, 0xff]))).rejects.toThrow(
      'content type does not match image bytes',
    );
  });

  it('rejects unsupported and empty images', async () => {
    await expect(inspectPrescriptionImage('image/gif', new Uint8Array([0x47, 0x49, 0x46]))).rejects.toThrow(
      'unsupported image content type',
    );
    await expect(inspectPrescriptionImage('image/png', new Uint8Array())).rejects.toThrow('image is empty');
  });

  it('rejects images over 10 MiB', async () => {
    await expect(inspectPrescriptionImage('image/jpeg', new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(
      'image exceeds 10 MiB',
    );
  });
});

describe('readPrescriptionImageBody', () => {
  it('preserves bytes split across chunks up to the exact limit', async () => {
    const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    bytes.set([0xff, 0xd8, 0xff]);
    bytes[MAX_IMAGE_BYTES - 1] = 123;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1));
        controller.enqueue(bytes.subarray(1, 3));
        controller.enqueue(bytes.subarray(3));
        controller.close();
      },
    });
    const result = await readPrescriptionImageBody(body);
    expect(result?.byteLength).toBe(MAX_IMAGE_BYTES);
    expect(Buffer.compare(result!, bytes)).toBe(0);
    expect(await inspectPrescriptionImage('image/jpeg', result!)).toEqual(
      await inspectPrescriptionImage('image/jpeg', bytes),
    );
    expect(body.locked).toBe(false);
  });

  it('preserves empty input and propagates stream failure while releasing the lock', async () => {
    expect(await readPrescriptionImageBody(null)).toEqual(new Uint8Array());
    const failure = new Error('synthetic read failure');
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    await expect(readPrescriptionImageBody(body)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
});
