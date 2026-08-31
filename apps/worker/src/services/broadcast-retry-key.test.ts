import { describe, expect, test } from 'vitest';
import {
  createBroadcastRetryKey,
  createFormLinkRetryKey,
  isLineRetryKey,
} from './broadcast-retry-key.js';

describe('isLineRetryKey', () => {
  test('accepts LINE-compatible UUIDs and rejects malformed values', () => {
    expect(isLineRetryKey('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isLineRetryKey('123E4567-E89B-42D3-A456-426614174000')).toBe(true);
    expect(isLineRetryKey('not-a-uuid')).toBe(false);
  });
});

describe('createBroadcastRetryKey', () => {
  test('is stable, UUID-shaped, and changes with delivery content', async () => {
    const first = await createBroadcastRetryKey('broadcast-1', 'friend-1', 'hello');
    const retry = await createBroadcastRetryKey('broadcast-1', 'friend-1', 'hello');
    const edited = await createBroadcastRetryKey('broadcast-1', 'friend-1', 'hello again');

    expect(first).toBe(retry);
    expect(first).not.toBe(edited);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('createFormLinkRetryKey', () => {
  test('deduplicates OAuth and LIFF retries for the same campaign link', async () => {
    const params = {
      friendId: 'friend-1',
      formId: 'form-1',
      ref: 'campaign-1',
      gate: 'gate-1',
      xh: '',
    };

    const oauth = await createFormLinkRetryKey(params);
    const liffRetry = await createFormLinkRetryKey(params);
    const otherCampaign = await createFormLinkRetryKey({ ...params, ref: 'campaign-2' });

    expect(oauth).toBe(liffRetry);
    expect(oauth).not.toBe(otherCampaign);
    expect(oauth).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
