import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('hashes text and bytes to the same lowercase hex digest', async () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223' +
      'b00361a396177a9cb410ff61f20015ad';

    await expect(sha256Hex('abc')).resolves.toBe(expected);
    await expect(sha256Hex(new TextEncoder().encode('abc'))).resolves.toBe(expected);
  });
});
