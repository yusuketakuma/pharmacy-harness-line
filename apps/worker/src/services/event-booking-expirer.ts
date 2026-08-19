// Cron handler: expire 24h-old `requested` event bookings + purge
// idempotency rows. Mirrors booking-expirer.ts but without a friend
// notification — spec §7.1 lists no expired-kind notification for events.

import { purgeExpiredEventIdempotency } from './event-booking-idempotency.js';
import { REQUESTED_EXPIRE_HOURS } from './event-booking-types.js';

interface StaleRow {
  id: string;
}

export interface RunEventBookingExpirerParams {
  now: Date;
}

export async function runEventBookingExpirer(
  db: D1Database,
  params: RunEventBookingExpirerParams,
): Promise<{ expired: number; idempotencyPurged: number }> {
  const cutoff = new Date(
    params.now.getTime() - REQUESTED_EXPIRE_HOURS * 3600_000,
  ).toISOString();
  const stale = await db
    .prepare(
      `SELECT b.id
         FROM event_bookings b
        INNER JOIN events e
                ON e.id = b.event_id AND e.line_account_id = b.line_account_id
        INNER JOIN event_slots s
                ON s.id = b.slot_id AND s.event_id = b.event_id
        INNER JOIN line_accounts la
                ON la.id = b.line_account_id AND la.is_active = 1
        INNER JOIN tenant_line_accounts mapping
                ON mapping.line_account_id = la.id
        INNER JOIN tenants tenant
                ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
        INNER JOIN friends f
                ON f.id = b.friend_id AND f.line_account_id = b.line_account_id
        WHERE b.status = 'requested' AND b.requested_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_account_capabilities pac
             WHERE pac.line_account_id = b.line_account_id
               AND pac.mode = 'pharmacy'
          )
        LIMIT 200`,
    )
    .bind(cutoff)
    .all<StaleRow>();

  let expired = 0;
  for (const row of stale.results ?? []) {
    // Conditional UPDATE to avoid racing with concurrent admin decide.
    const upd = await db
      .prepare(
        `UPDATE event_bookings
            SET status = 'expired', decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'requested'`,
      )
      .bind(params.now.toISOString(), params.now.toISOString(), row.id)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) continue;
    await db
      .prepare(
        `UPDATE event_booking_reminders
            SET status = 'cancelled'
          WHERE booking_id = ? AND status IN ('pending','failed')`,
      )
      .bind(row.id)
      .run();
    expired++;
  }

  const idempotencyPurged = await purgeExpiredEventIdempotency(db, params.now);
  return { expired, idempotencyPurged };
}
