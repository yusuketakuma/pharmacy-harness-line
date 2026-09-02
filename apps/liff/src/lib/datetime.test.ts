import { describe, expect, test } from 'vitest';
import { formatTokyoDateTime } from './datetime.js';

describe('formatTokyoDateTime', () => {
  test('formats valid values in Tokyo and preserves invalid input', () => {
    const value = '2026-09-03T00:00:00.000Z';
    expect(formatTokyoDateTime(value)).toBe(new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(value)));
    expect(formatTokyoDateTime('not-a-date')).toBe('not-a-date');
  });
});
