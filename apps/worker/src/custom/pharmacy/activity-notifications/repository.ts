export type ActivityType =
  | 'prescription_received'
  | 'prescription_status_changed'
  | 'fulfillment_quote_created'
  | 'myna_handoff_received';

export interface ActivityNotification {
  id: string;
  line_account_id: string;
  activity_type: ActivityType;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

const TYPES = new Set<ActivityType>([
  'prescription_received', 'prescription_status_changed',
  'fulfillment_quote_created', 'myna_handoff_received',
]);
const SELECT = `
  SELECT id, line_account_id, activity_type, acknowledged_by, acknowledged_at,
         created_at, updated_at
    FROM pharmacy_activity_notifications`;

async function dedupeHash(value: string): Promise<string> {
  if (!value || value.length > 512) throw new Error('invalid activity idempotency key');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createActivityNotification(
  db: D1Database,
  input: { lineAccountId: string; activityType: ActivityType; idempotencyKey: string },
): Promise<ActivityNotification | null> {
  if (!TYPES.has(input.activityType)) throw new Error('invalid activity type');
  const hash = await dedupeHash(input.idempotencyKey);
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO pharmacy_activity_notifications
       (id, line_account_id, activity_type, dedupe_hash, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM line_accounts WHERE id = ? AND is_active = 1)
     ON CONFLICT (line_account_id, dedupe_hash) DO NOTHING`,
  ).bind(
    id, input.lineAccountId, input.activityType, hash, timestamp, timestamp, input.lineAccountId,
  ).run();
  const item = await db.prepare(
    `${SELECT} WHERE line_account_id = ? AND dedupe_hash = ?`,
  ).bind(input.lineAccountId, hash).first<ActivityNotification>();
  if (item && item.activity_type !== input.activityType) throw new Error('activity idempotency conflict');
  return item;
}

export async function enqueueActivityForAccount(
  db: D1Database,
  lineAccountId: string,
  activityType: ActivityType,
  idempotencyKey: string,
): Promise<ActivityNotification | null> {
  return createActivityNotification(db, { lineAccountId, activityType, idempotencyKey });
}

export async function listActivityNotifications(
  db: D1Database,
  lineAccountId: string,
  acknowledged: boolean,
  limit: number,
): Promise<ActivityNotification[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const result = await db.prepare(
    `${SELECT}
      WHERE line_account_id = ? AND acknowledged_at IS ${acknowledged ? 'NOT NULL' : 'NULL'}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(lineAccountId, boundedLimit).all<ActivityNotification>();
  return result.results ?? [];
}

export async function acknowledgeActivityNotification(
  db: D1Database,
  lineAccountId: string,
  notificationId: string,
  staffId: string,
  at = new Date(),
): Promise<ActivityNotification | null> {
  const timestamp = at.toISOString();
  await db.prepare(
    `UPDATE pharmacy_activity_notifications
        SET acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND acknowledged_at IS NULL`,
  ).bind(staffId, timestamp, timestamp, notificationId, lineAccountId).run();
  return db.prepare(`${SELECT} WHERE id = ? AND line_account_id = ?`)
    .bind(notificationId, lineAccountId).first<ActivityNotification>();
}
