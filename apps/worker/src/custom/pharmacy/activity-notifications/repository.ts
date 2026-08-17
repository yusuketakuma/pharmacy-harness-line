export type ActivityType =
  | 'prescription_received'
  | 'prescription_status_changed'
  | 'fulfillment_quote_created'
  | 'myna_handoff_received'
  | 'patient_message_received'
  | 'continuity_due'
  | 'manual_activity'

export type ActivityNotificationStatus = 'unread' | 'claimed' | 'acknowledged'

export interface ActivityNotification {
  id: string
  line_account_id: string
  staff_id: string
  activity_type: ActivityType
  idempotency_key: string
  status: ActivityNotificationStatus
  claimed_by: string | null
  claimed_at: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  created_at: string
  updated_at: string
}

const SELECT = `
  SELECT id, line_account_id, staff_id, activity_type, idempotency_key,
         status, claimed_by, claimed_at, acknowledged_by, acknowledged_at,
         created_at, updated_at
    FROM pharmacy_activity_notifications`

export async function assertStaffInPharmacyAccount(
  db: D1Database,
  lineAccountId: string,
  staffId: string,
): Promise<void> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM staff
      WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL`,
  ).bind(staffId, lineAccountId).first<{ ok: number }>()
  if (!row?.ok) throw new Error('staff is not assigned to pharmacy account')
}

export const assertMembership = assertStaffInPharmacyAccount

export async function createActivityNotification(
  db: D1Database,
  input: {
    lineAccountId: string
    staffId: string
    activityType: ActivityType
    idempotencyKey: string
  },
): Promise<ActivityNotification | null> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const result = await db.batch([
    db.prepare(
      `INSERT INTO pharmacy_activity_notifications
         (id, line_account_id, staff_id, activity_type, idempotency_key,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'unread', ?, ?)
       ON CONFLICT (line_account_id, staff_id, idempotency_key) DO NOTHING`,
    ).bind(id, input.lineAccountId, input.staffId, input.activityType, input.idempotencyKey, now, now),
    db.prepare(
      `INSERT INTO pharmacy_activity_notification_events
         (id, notification_id, line_account_id, event_type, actor_type, created_at)
       SELECT ?, n.id, n.line_account_id, 'created', 'system', ?
         FROM pharmacy_activity_notifications n
        WHERE n.line_account_id = ? AND n.staff_id = ? AND n.idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1
              FROM pharmacy_activity_notification_events existing
             WHERE existing.notification_id = n.id
               AND existing.line_account_id = n.line_account_id
               AND existing.event_type = 'created'
          )`,
    ).bind(crypto.randomUUID(), now, input.lineAccountId, input.staffId, input.idempotencyKey),
  ])
  if ((result[0]?.meta?.changes ?? 0) !== 1) {
    const existing = await db.prepare(
      `${SELECT} WHERE line_account_id = ? AND staff_id = ? AND idempotency_key = ?`,
    ).bind(input.lineAccountId, input.staffId, input.idempotencyKey).first<ActivityNotification>()
    if (existing && existing.activity_type !== input.activityType) {
      throw new Error('activity notification idempotency conflict')
    }
    return existing
  }
  return db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ?`)
    .bind(id, input.lineAccountId).first<ActivityNotification>()
}

export async function listActivityNotifications(
  db: D1Database,
  lineAccountId: string,
  staffId: string,
  options: { status: ActivityNotificationStatus | null; limit: number },
): Promise<ActivityNotification[]> {
  const { status, limit } = options
  const filter = status ? ' AND status = ?' : ''
  const values = status ? [lineAccountId, staffId, status, limit] : [lineAccountId, staffId, limit]
  const result = await db.prepare(
    `${SELECT}
      WHERE line_account_id = ? AND staff_id = ?${filter}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...values).all<ActivityNotification>()
  return result.results ?? []
}

export async function claimActivityNotification(
  db: D1Database,
  lineAccountId: string,
  notificationId: string,
  staffId: string,
  now = new Date(),
): Promise<ActivityNotification | null> {
  const timestamp = now.toISOString()
  const result = await db.batch([
    db.prepare(
      `UPDATE pharmacy_activity_notifications
          SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND staff_id = ? AND status = 'unread'`,
    ).bind(staffId, timestamp, timestamp, notificationId, lineAccountId, staffId),
    db.prepare(
      `INSERT INTO pharmacy_activity_notification_events
         (id, notification_id, line_account_id, event_type, actor_type, actor_id, created_at)
       SELECT ?, n.id, n.line_account_id, 'claimed', 'staff', ?, ?
         FROM pharmacy_activity_notifications n
        WHERE n.id = ? AND n.line_account_id = ? AND n.staff_id = ?
          AND n.status = 'claimed' AND n.claimed_by = ? AND n.claimed_at = ?
          AND NOT EXISTS (
            SELECT 1
              FROM pharmacy_activity_notification_events existing
             WHERE existing.notification_id = n.id
               AND existing.line_account_id = n.line_account_id
               AND existing.event_type = 'claimed'
               AND existing.actor_id = ?
          )`,
    ).bind(
      crypto.randomUUID(), staffId, timestamp,
      notificationId, lineAccountId, staffId, staffId, timestamp, staffId,
    ),
  ])
  if ((result[0]?.meta?.changes ?? 0) !== 1) {
    const existing = await db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ? AND staff_id = ?`)
      .bind(notificationId, lineAccountId, staffId).first<ActivityNotification>()
    if (!existing) return null
    if (existing.status === 'claimed' && existing.claimed_by === staffId) return existing
    throw new Error('activity notification claim conflict')
  }
  return db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ? AND staff_id = ?`)
    .bind(notificationId, lineAccountId, staffId).first<ActivityNotification>()
}

export async function acknowledgeActivityNotification(
  db: D1Database,
  lineAccountId: string,
  notificationId: string,
  staffId: string,
  now = new Date(),
): Promise<ActivityNotification | null> {
  const timestamp = now.toISOString()
  const result = await db.batch([
    db.prepare(
      `UPDATE pharmacy_activity_notifications
          SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND staff_id = ?
          AND status = 'claimed' AND claimed_by = ?`,
    ).bind(staffId, timestamp, timestamp, notificationId, lineAccountId, staffId, staffId),
    db.prepare(
      `INSERT INTO pharmacy_activity_notification_events
         (id, notification_id, line_account_id, event_type, actor_type, actor_id, created_at)
       SELECT ?, n.id, n.line_account_id, 'acknowledged', 'staff', ?, ?
         FROM pharmacy_activity_notifications n
        WHERE n.id = ? AND n.line_account_id = ? AND n.staff_id = ?
          AND n.status = 'acknowledged' AND n.acknowledged_by = ?
          AND n.acknowledged_at = ?
          AND NOT EXISTS (
            SELECT 1
              FROM pharmacy_activity_notification_events existing
             WHERE existing.notification_id = n.id
               AND existing.line_account_id = n.line_account_id
               AND existing.event_type = 'acknowledged'
               AND existing.actor_id = ?
          )`,
    ).bind(
      crypto.randomUUID(), staffId, timestamp,
      notificationId, lineAccountId, staffId, staffId, timestamp, staffId,
    ),
  ])
  if ((result[0]?.meta?.changes ?? 0) !== 1) {
    const existing = await db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ? AND staff_id = ?`)
      .bind(notificationId, lineAccountId, staffId).first<ActivityNotification>()
    if (!existing) return null
    if (existing.status === 'acknowledged' && existing.acknowledged_by === staffId) return existing
    throw new Error('activity notification acknowledgement conflict')
  }
  return db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ? AND staff_id = ?`)
    .bind(notificationId, lineAccountId, staffId).first<ActivityNotification>()
}

export async function listActivityNotificationEvents(
  db: D1Database,
  lineAccountId: string,
  notificationId: string,
  staffId: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(
    `SELECT e.id, e.event_type, e.actor_type, e.actor_id, e.created_at
       FROM pharmacy_activity_notification_events e
       INNER JOIN pharmacy_activity_notifications n
         ON n.id = e.notification_id AND n.line_account_id = e.line_account_id
      WHERE e.notification_id = ? AND e.line_account_id = ? AND n.staff_id = ?
      ORDER BY e.created_at, e.id`,
  ).bind(notificationId, lineAccountId, staffId).all<Record<string, unknown>>()
  return result.results ?? []
}

// Short aliases keep the service seam small and easy to replace in tests.
export const create = createActivityNotification
export const list = listActivityNotifications
export const claim = claimActivityNotification
export const acknowledge = acknowledgeActivityNotification
export const listEvents = listActivityNotificationEvents
