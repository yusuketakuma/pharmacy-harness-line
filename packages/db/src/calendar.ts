import { jstNow } from './utils.js';
// Google Calendar 連携クエリヘルパー

export interface GoogleCalendarConnectionRow {
  id: string;
  tenant_id: string | null;
  calendar_id: string;
  line_account_id: string | null;
  staff_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  auth_type: string;
  is_active: number;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarBookingRow {
  id: string;
  connection_id: string;
  friend_id: string | null;
  event_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

// --- 接続管理 ---

export async function getCalendarConnections(
  db: D1Database,
  tenantId: string | null = null,
): Promise<GoogleCalendarConnectionRow[]> {
  const result = await db
    .prepare(`SELECT * FROM google_calendar_connections WHERE tenant_id IS ? ORDER BY created_at DESC`)
    .bind(tenantId)
    .all<GoogleCalendarConnectionRow>();
  return result.results;
}

export async function getCalendarConnectionById(
  db: D1Database,
  id: string,
  tenantId: string | null = null,
): Promise<GoogleCalendarConnectionRow | null> {
  return db
    .prepare(`SELECT * FROM google_calendar_connections WHERE id = ? AND tenant_id IS ?`)
    .bind(id, tenantId)
    .first<GoogleCalendarConnectionRow>();
}

export async function createCalendarConnection(
  db: D1Database,
  input: {
    calendarId: string;
    authType: string;
    lineAccountId?: string;
    staffId?: string;
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
    tenantId?: string | null;
  },
): Promise<GoogleCalendarConnectionRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO google_calendar_connections
              (id, tenant_id, calendar_id, line_account_id, staff_id, auth_type,
               access_token, refresh_token, api_key, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      input.tenantId ?? null,
      input.calendarId,
      input.lineAccountId ?? null,
      input.staffId ?? null,
      input.authType,
      input.accessToken ?? null,
      input.refreshToken ?? null,
      input.apiKey ?? null,
      now,
      now,
    )
    .run();
  return (await getCalendarConnectionById(db, id, input.tenantId ?? null))!;
}

export async function deleteCalendarConnection(
  db: D1Database,
  id: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM google_calendar_connections WHERE id = ? AND tenant_id IS ?`)
    .bind(id, tenantId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// --- 予約管理 ---

export async function getCalendarBookings(
  db: D1Database,
  opts: { connectionId?: string; friendId?: string; tenantId?: string | null } = {},
): Promise<CalendarBookingRow[]> {
  const clauses = ['connection.tenant_id IS ?'];
  const values: unknown[] = [opts.tenantId ?? null];
  if (opts.friendId) {
    clauses.push('booking.friend_id = ?');
    values.push(opts.friendId);
  } else if (opts.connectionId) {
    clauses.push('booking.connection_id = ?');
    values.push(opts.connectionId);
  }
  const result = await db.prepare(
    `SELECT booking.*
       FROM calendar_bookings AS booking
       INNER JOIN google_calendar_connections AS connection
         ON connection.id = booking.connection_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY booking.start_at ASC`,
  ).bind(...values).all<CalendarBookingRow>();
  return result.results;
}

export async function getCalendarBookingById(
  db: D1Database,
  id: string,
  tenantId: string | null = null,
): Promise<CalendarBookingRow | null> {
  return db.prepare(
    `SELECT booking.*
       FROM calendar_bookings AS booking
       INNER JOIN google_calendar_connections AS connection
         ON connection.id = booking.connection_id
      WHERE booking.id = ? AND connection.tenant_id IS ?`,
  ).bind(id, tenantId).first<CalendarBookingRow>();
}

export async function createCalendarBooking(
  db: D1Database,
  input: {
    connectionId: string;
    friendId?: string;
    eventId?: string;
    title: string;
    startAt: string;
    endAt: string;
    metadata?: string;
    tenantId?: string | null;
  },
): Promise<CalendarBookingRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO calendar_bookings
              (id, connection_id, friend_id, event_id, title, start_at, end_at,
               metadata, created_at, updated_at)
              SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?
                FROM google_calendar_connections
               WHERE id = ? AND tenant_id IS ?`)
    .bind(
      id,
      input.friendId ?? null,
      input.eventId ?? null,
      input.title,
      input.startAt,
      input.endAt,
      input.metadata ?? null,
      now,
      now,
      input.connectionId,
      input.tenantId ?? null,
    )
    .run();
  const booking = await getCalendarBookingById(db, id, input.tenantId ?? null);
  if (!booking) throw new Error('CALENDAR_CONNECTION_SCOPE_MISMATCH');
  return booking;
}

export async function updateCalendarBookingStatus(
  db: D1Database,
  id: string,
  status: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE calendar_bookings SET status = ?, updated_at = ?
      WHERE id = ? AND connection_id IN (
        SELECT id FROM google_calendar_connections WHERE tenant_id IS ?
      )`,
  ).bind(status, jstNow(), id, tenantId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function updateCalendarBookingEventId(
  db: D1Database,
  id: string,
  eventId: string,
  tenantId: string | null = null,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE calendar_bookings SET event_id = ?, updated_at = ?
      WHERE id = ? AND connection_id IN (
        SELECT id FROM google_calendar_connections WHERE tenant_id IS ?
      )`,
  ).bind(eventId, jstNow(), id, tenantId).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 空きスロット計算用: 指定日範囲の予約一覧を取得 */
export async function getBookingsInRange(
  db: D1Database,
  connectionId: string,
  startAt: string,
  endAt: string,
  tenantId: string | null = null,
): Promise<CalendarBookingRow[]> {
  const result = await db
    .prepare(
      `SELECT booking.*
         FROM calendar_bookings AS booking
         INNER JOIN google_calendar_connections AS connection
           ON connection.id = booking.connection_id
        WHERE booking.connection_id = ? AND connection.tenant_id IS ?
          AND booking.start_at >= ? AND booking.end_at <= ?
          AND booking.status != 'cancelled'
        ORDER BY booking.start_at ASC`,
    )
    .bind(connectionId, tenantId, startAt, endAt)
    .all<CalendarBookingRow>();
  return result.results;
}
