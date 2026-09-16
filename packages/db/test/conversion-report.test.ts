import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getConversionReport } from '../src/conversions.js';

describe('conversion report value', () => {
  it('counts value only for events matched by the date range', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(readFileSync(join(import.meta.dirname, '../bootstrap.sql'), 'utf8'));
      sqlite.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('account-a', 'channel-a', 'Synthetic', 'synthetic-token', 'synthetic-secret')`).run();
      sqlite.prepare(`INSERT INTO friends (id, line_user_id, line_account_id)
        VALUES ('friend-a', 'synthetic-user', 'account-a')`).run();
      sqlite.prepare(`INSERT INTO conversion_points (id, name, event_type, value) VALUES
        ('valued', 'Valued', 'purchase', 1000), ('null-value', 'Null value', 'purchase', NULL)`).run();
      const db = {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return { async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] }; } };
            },
          };
        },
      } as D1Database;
      const report = (range?: { startDate: string; endDate: string }) =>
        getConversionReport(db, range);
      const totals = async (range?: { startDate: string; endDate: string }) =>
        (await report(range)).map(({ conversionPointId, totalCount, totalValue }) =>
          ({ conversionPointId, totalCount, totalValue }))
          .sort((a, b) => a.conversionPointId.localeCompare(b.conversionPointId));

      expect(await totals()).toEqual([
        { conversionPointId: 'null-value', totalCount: 0, totalValue: 0 },
        { conversionPointId: 'valued', totalCount: 0, totalValue: 0 },
      ]);
      sqlite.prepare(`INSERT INTO conversion_events
        (id, conversion_point_id, friend_id, created_at) VALUES
        ('event-a', 'valued', 'friend-a', '2026-09-01'),
        ('event-b', 'valued', 'friend-a', '2026-09-03'),
        ('event-c', 'null-value', 'friend-a', '2026-09-03')`).run();
      expect(await totals()).toEqual([
        { conversionPointId: 'null-value', totalCount: 1, totalValue: 0 },
        { conversionPointId: 'valued', totalCount: 2, totalValue: 2000 },
      ]);
      expect(await totals({ startDate: '2026-09-02', endDate: '2026-09-02' })).toEqual([
        { conversionPointId: 'null-value', totalCount: 0, totalValue: 0 },
        { conversionPointId: 'valued', totalCount: 0, totalValue: 0 },
      ]);
      expect(await totals({ startDate: '2026-09-03', endDate: '2026-09-03' })).toEqual([
        { conversionPointId: 'null-value', totalCount: 1, totalValue: 0 },
        { conversionPointId: 'valued', totalCount: 1, totalValue: 1000 },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
