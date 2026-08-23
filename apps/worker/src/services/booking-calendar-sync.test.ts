import { afterEach, describe, expect, test, vi } from 'vitest';
import { syncConfirmedBookingToGoogle } from './booking-calendar-sync.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncConfirmedBookingToGoogle', () => {
  test('Google Calendarへ患者情報や相談内容を送らない', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({
            id: '01234567-89ab-cdef-0123-456789abcdef',
            starts_at: '2026-08-24T01:00:00.000Z',
            ends_at: '2026-08-24T01:15:00.000Z',
            customer_note: '処方内容について相談したい',
            external_event_id: null,
            friend_name: '患者 山田',
            menu_name: 'オンライン服薬指導',
            staff_name: '薬剤師 佐藤',
            connection_id: 'connection-1',
            calendar_id: 'primary',
            auth_type: 'access_token',
            access_token: 'token',
            refresh_token: null,
          })),
          run,
        })),
      })),
    } as unknown as D1Database;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'event-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await syncConfirmedBookingToGoogle(
      db,
      {},
      '01234567-89ab-cdef-0123-456789abcdef',
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: '0123456789abcdef0123456789abcdef',
      summary: 'LINE Harness予約',
      start: { dateTime: '2026-08-24T01:00:00.000Z' },
      end: { dateTime: '2026-08-24T01:15:00.000Z' },
    });
    expect(body).not.toHaveProperty('description');
    expect(JSON.stringify(body)).not.toMatch(/患者 山田|オンライン服薬指導|処方内容|薬剤師 佐藤/);
    expect(run).toHaveBeenCalledOnce();
  });
});
