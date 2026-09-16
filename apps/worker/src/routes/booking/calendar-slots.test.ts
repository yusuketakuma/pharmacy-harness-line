import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  getCalendarConnectionById: vi.fn(async () => ({ id: 'calendar-1', calendar_id: 'calendar-1', access_token: null })),
  getBookingsInRange: vi.fn(async () => []),
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...dbMocks,
}));

const { calendar } = await import('./calendar.js');
const app = new Hono();
app.route('/', calendar);
const env = { DB: {} as D1Database };
const path = '/api/integrations/google-calendar/slots?connectionId=calendar-1&date=2026-09-16';

describe('calendar slots input bounds', () => {
  test.each([
    'slotMinutes=NaN', 'slotMinutes=Infinity', 'slotMinutes=',
    'slotMinutes=0', 'slotMinutes=-1', 'slotMinutes=0.001', 'slotMinutes=1441',
    'startHour=-1', 'endHour=25', 'startHour=18&endHour=9',
    'date=2026-02-30',
  ])('rejects %s before loading calendar data', async (query) => {
    dbMocks.getCalendarConnectionById.mockClear();
    const url = query.startsWith('date=')
      ? path.replace('date=2026-09-16', query)
      : `${path}&${query}`;
    const response = await app.request(url, {}, env);
    expect(response.status).toBe(400);
    expect(dbMocks.getCalendarConnectionById).not.toHaveBeenCalled();
  });

  test('keeps the default JST slot response', async () => {
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(200);
    const result = await response.json() as { success: boolean; data: { startAt: string; endAt: string; available: boolean }[] };
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(9);
    expect(result.data[0]).toEqual({
      startAt: '2026-09-16T09:00:00.000+09:00',
      endAt: '2026-09-16T10:00:00.000+09:00',
      available: true,
    });
  });
});
