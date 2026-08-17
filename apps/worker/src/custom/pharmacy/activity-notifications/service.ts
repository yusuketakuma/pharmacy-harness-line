import {
  acknowledge as acknowledgeRepository,
  assertMembership,
  claim as claimRepository,
  create,
  listEvents as listEventsRepository,
  list,
  type ActivityNotification,
  type ActivityNotificationStatus,
  type ActivityType,
} from './repository.js'

const ACTIVITY_TYPES = new Set<ActivityType>([
  'prescription_received', 'prescription_status_changed', 'fulfillment_quote_created',
  'myna_handoff_received', 'patient_message_received', 'continuity_due', 'manual_activity',
])

export async function enqueueActivityNotifications(
  db: D1Database,
  input: {
    lineAccountId: string
    activityType: ActivityType
    staffIds: string[]
    idempotencyKey: string
  },
): Promise<ActivityNotification[]> {
  if (!ACTIVITY_TYPES.has(input.activityType)) throw new Error('invalid activity type')
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.idempotencyKey)) throw new Error('invalid idempotency key')
  const staffIds = [...new Set(input.staffIds)]
  for (const staffId of staffIds) {
    await assertMembership(db, input.lineAccountId, staffId)
  }
  const result: ActivityNotification[] = []
  for (const staffId of staffIds) {
    const notification = await create(db, {
      lineAccountId: input.lineAccountId,
      staffId,
      activityType: input.activityType,
      idempotencyKey: input.idempotencyKey,
    })
    if (notification) result.push(notification)
  }
  return result
}

export async function enqueueActivityForAccount(
  db: D1Database,
  lineAccountId: string,
  activityType: ActivityType,
  idempotencyKey: string,
): Promise<ActivityNotification[]> {
  const staff = await db.prepare(
    `SELECT id FROM staff
      WHERE line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
      ORDER BY id`,
  ).bind(lineAccountId).all<{ id: string }>()
  return enqueueActivityNotifications(db, {
    lineAccountId,
    activityType,
    staffIds: (staff.results ?? []).map((row) => row.id),
    idempotencyKey,
  })
}

export async function listActivityNotifications(
  db: D1Database, lineAccountId: string, staffId: string,
  options: { status: ActivityNotificationStatus | null; limit: number },
) {
  await assertMembership(db, lineAccountId, staffId)
  return list(db, lineAccountId, staffId, options)
}

export async function claimActivityNotification(db: D1Database, lineAccountId: string, id: string, staffId: string) {
  await assertMembership(db, lineAccountId, staffId)
  return claimRepository(db, lineAccountId, id, staffId)
}

export async function acknowledgeActivityNotification(db: D1Database, lineAccountId: string, id: string, staffId: string) {
  await assertMembership(db, lineAccountId, staffId)
  return acknowledgeRepository(db, lineAccountId, id, staffId)
}

export async function listActivityNotificationEvents(db: D1Database, lineAccountId: string, id: string, staffId: string) {
  await assertMembership(db, lineAccountId, staffId)
  return listEventsRepository(db, lineAccountId, id, staffId)
}
