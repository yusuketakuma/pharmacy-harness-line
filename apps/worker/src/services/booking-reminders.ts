// Cron handler: send due booking reminders.
// Joined with bookings/menus/staff/line_accounts/friends for everything
// the notification text renderer needs in one query.

import type { BookingNotificationSender, NotificationKind } from './booking-notifier.js';
import { REMINDER_MAX_RETRY } from './booking-types.js';

interface DueRow {
  id: string;
  booking_id: string;
  kind: 'day_before' | 'hours_before';
  retry_count: number;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  line_user_id: string;
  tenant_id: string;
  line_account_id: string;
  friend_id: string;
}

export interface ProcessRemindersParams {
  now: Date;
  sender: BookingNotificationSender;
  reminderHoursBefore: number;
}

const JST_OFFSET_MS = 9 * 3600_000;
const CLAIM_STALE_MS = 15 * 60_000;
const LINE_RETRY_HORIZON_MS = 24 * 3600_000;

function startsAtJst(utcIso: string): string {
  const jst = new Date(new Date(utcIso).getTime() + JST_OFFSET_MS).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

export async function processDueReminders(
  db: D1Database,
  params: ProcessRemindersParams,
): Promise<{ sent: number; failed: number }> {
  const nowIso = params.now.toISOString();
  const staleClaimAt = new Date(params.now.getTime() - CLAIM_STALE_MS).toISOString();
  const retryHorizonAt = new Date(params.now.getTime() - LINE_RETRY_HORIZON_MS).toISOString();
  await db.prepare(
    `UPDATE booking_reminders
        SET status='failed_permanent', last_error='LINE_RETRY_HORIZON_EXPIRED'
      WHERE status IN ('processing','failed') AND first_attempted_at <= ?`,
  ).bind(retryHorizonAt).run();

  // status は 'pending' に加え 'failed'（一時エラーで失敗、retry 残あり）も拾う。
  // 'failed_permanent' / 'sent' / 'cancelled' は再送対象外。
  const due = await db
    .prepare(
      `SELECT r.id, r.booking_id, r.kind, r.retry_count,
              b.starts_at,
              m.name AS menu_name,
              s.display_name AS staff_name,
              la.channel_access_token,
              f.provider_line_user_id AS line_user_id,
              mapping.tenant_id,
              b.line_account_id,
              b.friend_id
         FROM booking_reminders r
         INNER JOIN bookings b ON b.id = r.booking_id
         INNER JOIN menus m
                 ON m.id = b.menu_id AND m.line_account_id = b.line_account_id
         INNER JOIN staff s
                 ON s.id = b.staff_id AND s.line_account_id = b.line_account_id
         INNER JOIN line_accounts la ON la.id = b.line_account_id
         INNER JOIN tenant_line_accounts mapping
                 ON mapping.line_account_id = la.id
         INNER JOIN tenants tenant
                 ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
         INNER JOIN friends f
                 ON f.id = b.friend_id AND f.line_account_id = b.line_account_id
        WHERE r.scheduled_at <= ?
          AND (
            (r.status IN ('pending','failed')
             AND (r.first_attempted_at IS NULL OR r.first_attempted_at > ?))
            OR (r.status = 'processing' AND r.claimed_at <= ?
                AND r.first_attempted_at > ?)
          )
          AND b.status = 'confirmed'
          AND b.starts_at > ?       -- 開始時刻を過ぎた予約のリマインダは送らない
          AND la.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_account_capabilities pac
             WHERE pac.line_account_id = b.line_account_id AND pac.mode = 'pharmacy'
          )
        LIMIT 100`,
    )
    .bind(nowIso, retryHorizonAt, staleClaimAt, retryHorizonAt, nowIso)
    .all<DueRow>();

  let sent = 0;
  let failed = 0;
  for (const row of due.results) {
    const claim = await db.prepare(
      `UPDATE booking_reminders
          SET retry_count = retry_count + 1, status='processing', claimed_at=?,
              first_attempted_at=COALESCE(first_attempted_at, ?), last_error=NULL
        WHERE id = ? AND retry_count = ?
          AND (status IN ('pending','failed')
               OR (status='processing' AND claimed_at <= ?))
          AND (first_attempted_at IS NULL OR first_attempted_at > ?)`,
    ).bind(nowIso, nowIso, row.id, row.retry_count, staleClaimAt, retryHorizonAt).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;
    const claimedRetry = row.retry_count + 1;
    const kind: NotificationKind = row.kind;
    try {
      await params.sender({
        db,
        tenantId: row.tenant_id,
        lineAccountId: row.line_account_id,
        friendId: row.friend_id,
        channelAccessToken: row.channel_access_token,
        toLineUserId: row.line_user_id,
        retryKey: row.id,
        kind,
        ctx: {
          menuName: row.menu_name,
          staffName: row.staff_name,
          startsAtJst: startsAtJst(row.starts_at),
          hoursBefore: params.reminderHoursBefore,
        },
      });
      const settled = await db
        .prepare(
          `UPDATE booking_reminders
              SET status='sent', sent_at = ?, claimed_at=NULL
            WHERE id = ? AND status='processing' AND retry_count = ?`,
        )
        .bind(nowIso, row.id, claimedRetry)
        .run();
      if ((settled.meta?.changes ?? 0) === 1) sent++;
    } catch (e) {
      const newStatus = claimedRetry >= REMINDER_MAX_RETRY ? 'failed_permanent' : 'failed';
      const settled = await db
        .prepare(
          `UPDATE booking_reminders
              SET status = ?, retry_count = ?, last_error = ?, claimed_at=NULL
            WHERE id = ? AND status='processing' AND retry_count = ?`,
        )
        .bind(
          newStatus,
          claimedRetry,
          (e instanceof Error ? e.message : String(e)).slice(0, 1000),
          row.id,
          claimedRetry,
        )
        .run();
      if ((settled.meta?.changes ?? 0) === 1) failed++;
    }
  }
  return { sent, failed };
}
