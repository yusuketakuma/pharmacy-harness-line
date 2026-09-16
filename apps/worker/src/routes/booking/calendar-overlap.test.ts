import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { createCalendarBooking, createCalendarConnection, getBookingsInRange } from '@line-crm/db';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../../custom/pharmacy/test-sqlite.js';
import { calendar } from './calendar.js';

describe('calendar booking overlap', () => {
  test('includes boundary-crossing and mixed-offset bookings without crossing scope', async () => {
    const sqlite = new Sqlite(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
      const db = d1FromSqlite(sqlite);
      const connection = await createCalendarConnection(db, { calendarId: 'primary', authType: 'oauth' });
      const other = await createCalendarConnection(db, { calendarId: 'other', authType: 'oauth' });
      const add = async (startAt: string, endAt: string, connectionId = connection.id) =>
        createCalendarBooking(db, { connectionId, title: 'synthetic booking', startAt, endAt });
      const left = await add('2026-09-16T08:30:00+09:00', '2026-09-16T09:30:00+09:00');
      const right = await add('2026-09-16T10:30:00+09:00', '2026-09-16T11:30:00+09:00');
      const cover = await add('2026-09-16T08:00:00+09:00', '2026-09-16T12:00:00+09:00');
      const inside = await add('2026-09-16T09:15:00+09:00', '2026-09-16T09:45:00+09:00');
      const utc = await add('2026-09-16T00:30:00Z', '2026-09-16T01:30:00Z');
      const naive = await add('2026-09-16T00:30:00', '2026-09-16T01:30:00');
      await add('2026-09-16T08:00:00+09:00', '2026-09-16T09:00:00+09:00');
      await add('2026-09-16T11:00:00+09:00', '2026-09-16T12:00:00+09:00');
      const cancelled = await add('2026-09-16T09:00:00+09:00', '2026-09-16T10:00:00+09:00');
      await db.prepare('UPDATE calendar_bookings SET status = ? WHERE id = ?').bind('cancelled', cancelled.id).run();
      await add('2026-09-16T09:00:00+09:00', '2026-09-16T10:00:00+09:00', other.id);

      const start = '2026-09-16T09:00:00+09:00';
      const end = '2026-09-16T11:00:00+09:00';
      const rows = await getBookingsInRange(db, connection.id, start, end);
      expect(rows.map((row) => row.id).sort()).toEqual([left, right, cover, inside, utc, naive].map((row) => row.id).sort());
      expect(await getBookingsInRange(db, connection.id, start, end, 'wrong-tenant')).toEqual([]);

      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM calendar_bookings
        WHERE connection_id = ? AND julianday(start_at) < julianday(?) AND julianday(end_at) > julianday(?)`)
        .all(connection.id, end, start) as { detail: string }[];
      expect(plan.some((row) => row.detail.includes('idx_calendar_bookings_connection_start_instant'))).toBe(true);

      const routeConnection = await createCalendarConnection(db, { calendarId: 'route', authType: 'oauth' });
      await add('2026-09-16T08:30:00+09:00', '2026-09-16T09:30:00+09:00', routeConnection.id);
      const app = new Hono();
      app.route('/', calendar);
      const response = await app.request(`/api/integrations/google-calendar/slots?connectionId=${routeConnection.id}&date=2026-09-16&startHour=9&endHour=11`, {}, { DB: db });
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { available: boolean }[] };
      expect(body.data.map((slot) => slot.available)).toEqual([false, true]);
    } finally {
      sqlite.close();
    }
  });
});
