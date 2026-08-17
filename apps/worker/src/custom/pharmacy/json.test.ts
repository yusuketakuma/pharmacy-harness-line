import { describe, expect, it } from 'vitest';
import { readJsonObject } from './json.js';

const requestWith = (value: unknown) => ({
  json: async <T>() => value as T,
});

describe('readJsonObject', () => {
  it('accepts only parsed JSON objects', async () => {
    await expect(readJsonObject(requestWith({ ok: true }))).resolves.toEqual({ ok: true });
    await expect(readJsonObject(requestWith([]))).resolves.toBeNull();
    await expect(readJsonObject({ json: async () => { throw new SyntaxError('invalid JSON'); } }))
      .resolves.toBeNull();
  });
});
