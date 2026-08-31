import { jstNow } from './utils.js';
// リマインダ配信クエリヘルパー

export interface ReminderRow {
  id: string;
  name: string;
  description: string | null;
  is_active: number;
  line_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderStepRow {
  id: string;
  reminder_id: string;
  offset_minutes: number;
  message_type: string;
  message_content: string;
  created_at: string;
}

export interface FriendReminderRow {
  id: string;
  friend_id: string;
  reminder_id: string;
  target_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface FriendReminderWithAccountRow extends FriendReminderRow {
  line_account_id: string;
}

export interface ReminderWriteScope {
  tenantId: string;
  staffId: string;
}

// --- リマインダCRUD ---

export async function getReminders(
  db: D1Database,
  tenantId: string,
  lineAccountId?: string,
): Promise<ReminderRow[]> {
  const accountFilter = lineAccountId ? ' AND reminder.line_account_id = ?' : '';
  const values = lineAccountId ? [tenantId, lineAccountId] : [tenantId];
  const result = await db.prepare(`
    SELECT reminder.*
      FROM reminders AS reminder
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE mapping.tenant_id = ?
       AND reminder.line_account_id IS NOT NULL
       ${accountFilter}
     ORDER BY reminder.created_at DESC
  `).bind(...values).all<ReminderRow>();
  return result.results;
}

export async function getReminderById(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<ReminderRow | null> {
  return db.prepare(`
    SELECT reminder.*
      FROM reminders AS reminder
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE reminder.id = ?
       AND mapping.tenant_id = ?
       AND reminder.line_account_id IS NOT NULL
     LIMIT 1
  `).bind(id, tenantId).first<ReminderRow>();
}

export async function createReminder(
  db: D1Database,
  input: {
    name: string;
    description?: string | null;
    lineAccountId: string;
    tenantId: string;
    staffId: string;
  },
): Promise<ReminderRow | null> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const inserted = await db.prepare(`
    INSERT INTO reminders
      (id, name, description, line_account_id, is_active, created_at, updated_at)
    SELECT ?, ?, ?, ?, 1, ?, ?
      FROM tenant_line_accounts AS mapping
      INNER JOIN line_accounts AS account
              ON account.id = mapping.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = ?
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = membership.staff_id
             AND staff.is_active = 1
     WHERE mapping.tenant_id = ?
       AND mapping.line_account_id = ?
  `).bind(
    id,
    input.name,
    input.description ?? null,
    input.lineAccountId,
    now,
    now,
    input.staffId,
    input.tenantId,
    input.lineAccountId,
  ).run();
  if ((inserted.meta?.changes ?? 0) !== 1) return null;
  return getReminderById(db, id, input.tenantId);
}

export async function updateReminder(
  db: D1Database,
  id: string,
  updates: Partial<{ name: string; description: string | null; isActive: boolean }>,
  scope: ReminderWriteScope,
): Promise<ReminderRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
  if (updates.isActive !== undefined) { sets.push('is_active = ?'); values.push(updates.isActive ? 1 : 0); }
  if (sets.length === 0) return getReminderById(db, id, scope.tenantId);

  sets.push('updated_at = ?');
  values.push(jstNow());
  values.push(id, scope.staffId, scope.tenantId);
  const updated = await db.prepare(`
    UPDATE reminders
       SET ${sets.join(', ')}
     WHERE reminders.id = ?
       AND reminders.line_account_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM tenant_line_accounts AS mapping
           INNER JOIN line_accounts AS account
                   ON account.id = mapping.line_account_id
                  AND account.is_active = 1
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
           INNER JOIN tenant_staff_memberships AS membership
                   ON membership.tenant_id = mapping.tenant_id
                  AND membership.staff_id = ?
                  AND membership.is_active = 1
           INNER JOIN staff_members AS staff
                   ON staff.id = membership.staff_id
                  AND staff.is_active = 1
          WHERE mapping.tenant_id = ?
            AND mapping.line_account_id = reminders.line_account_id
       )
  `).bind(...values).run();
  if ((updated.meta?.changes ?? 0) !== 1) return null;
  return getReminderById(db, id, scope.tenantId);
}

export async function deleteReminder(
  db: D1Database,
  id: string,
  scope: ReminderWriteScope,
): Promise<boolean> {
  const deleted = await db.prepare(`
    DELETE FROM reminders
     WHERE reminders.id = ?
       AND reminders.line_account_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM tenant_line_accounts AS mapping
           INNER JOIN line_accounts AS account
                   ON account.id = mapping.line_account_id
                  AND account.is_active = 1
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
           INNER JOIN tenant_staff_memberships AS membership
                   ON membership.tenant_id = mapping.tenant_id
                  AND membership.staff_id = ?
                  AND membership.is_active = 1
           INNER JOIN staff_members AS staff
                   ON staff.id = membership.staff_id
                  AND staff.is_active = 1
          WHERE mapping.tenant_id = ?
            AND mapping.line_account_id = reminders.line_account_id
       )
  `).bind(id, scope.staffId, scope.tenantId).run();
  return (deleted.meta?.changes ?? 0) === 1;
}

// --- リマインダステップ ---

export async function getReminderSteps(
  db: D1Database,
  reminderId: string,
  tenantId: string,
): Promise<ReminderStepRow[]> {
  const result = await db.prepare(`
    SELECT step.*
      FROM reminder_steps AS step
      INNER JOIN reminders AS reminder
              ON reminder.id = step.reminder_id
             AND reminder.line_account_id IS NOT NULL
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE step.reminder_id = ?
       AND mapping.tenant_id = ?
     ORDER BY step.offset_minutes ASC
  `).bind(reminderId, tenantId).all<ReminderStepRow>();
  return result.results;
}

export async function createReminderStep(
  db: D1Database,
  input: {
    reminderId: string;
    offsetMinutes: number;
    messageType: string;
    messageContent: string;
    tenantId: string;
    staffId: string;
  },
): Promise<ReminderStepRow | null> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const inserted = await db.prepare(`
    INSERT INTO reminder_steps
      (id, reminder_id, offset_minutes, message_type, message_content, created_at)
    SELECT ?, reminder.id, ?, ?, ?, ?
      FROM reminders AS reminder
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = ?
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = membership.staff_id
             AND staff.is_active = 1
     WHERE reminder.id = ?
       AND reminder.line_account_id IS NOT NULL
       AND mapping.tenant_id = ?
  `).bind(
    id,
    input.offsetMinutes,
    input.messageType,
    input.messageContent,
    now,
    input.staffId,
    input.reminderId,
    input.tenantId,
  ).run();
  if ((inserted.meta?.changes ?? 0) !== 1) return null;
  return db.prepare(`SELECT * FROM reminder_steps WHERE id = ?`).bind(id).first<ReminderStepRow>();
}

export async function deleteReminderStep(
  db: D1Database,
  reminderId: string,
  id: string,
  scope: ReminderWriteScope,
): Promise<boolean> {
  const deleted = await db.prepare(`
    DELETE FROM reminder_steps
     WHERE reminder_steps.id = ?
       AND reminder_steps.reminder_id = ?
       AND EXISTS (
         SELECT 1
           FROM reminders AS reminder
           INNER JOIN tenant_line_accounts AS mapping
                   ON mapping.line_account_id = reminder.line_account_id
           INNER JOIN line_accounts AS account
                   ON account.id = reminder.line_account_id
                  AND account.is_active = 1
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
           INNER JOIN tenant_staff_memberships AS membership
                   ON membership.tenant_id = mapping.tenant_id
                  AND membership.staff_id = ?
                  AND membership.is_active = 1
           INNER JOIN staff_members AS staff
                   ON staff.id = membership.staff_id
                  AND staff.is_active = 1
          WHERE reminder.id = reminder_steps.reminder_id
            AND reminder.line_account_id IS NOT NULL
            AND mapping.tenant_id = ?
       )
  `).bind(id, reminderId, scope.staffId, scope.tenantId).run();
  return (deleted.meta?.changes ?? 0) === 1;
}

// --- 友だちリマインダ ---

export async function enrollFriendInReminder(
  db: D1Database,
  input: {
    friendId: string;
    reminderId: string;
    targetDate: string;
    tenantId: string;
    staffId: string;
  },
): Promise<FriendReminderRow | null> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const inserted = await db.prepare(`
    INSERT INTO friend_reminders
      (id, friend_id, reminder_id, target_date, created_at, updated_at)
    SELECT ?, friend.id, reminder.id, ?, ?, ?
      FROM reminders AS reminder
      INNER JOIN friends AS friend
              ON friend.id = ?
             AND friend.line_account_id = reminder.line_account_id
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
             AND mapping.tenant_id = ?
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
      INNER JOIN tenant_staff_memberships AS membership
              ON membership.tenant_id = mapping.tenant_id
             AND membership.staff_id = ?
             AND membership.is_active = 1
      INNER JOIN staff_members AS staff
              ON staff.id = membership.staff_id
             AND staff.is_active = 1
     WHERE reminder.id = ?
       AND reminder.line_account_id IS NOT NULL
  `).bind(
    id,
    input.targetDate,
    now,
    now,
    input.friendId,
    input.tenantId,
    input.staffId,
    input.reminderId,
  ).run();
  if ((inserted.meta?.changes ?? 0) !== 1) return null;
  return (await db.prepare(`SELECT * FROM friend_reminders WHERE id = ?`).bind(id).first<FriendReminderRow>())!;
}

export async function getFriendReminders(
  db: D1Database,
  friendId: string,
  tenantId: string,
): Promise<FriendReminderRow[]> {
  const result = await db.prepare(`
    SELECT friendReminder.*
      FROM friend_reminders AS friendReminder
      INNER JOIN reminders AS reminder
              ON reminder.id = friendReminder.reminder_id
             AND reminder.line_account_id IS NOT NULL
      INNER JOIN friends AS friend
              ON friend.id = friendReminder.friend_id
             AND friend.line_account_id = reminder.line_account_id
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE friendReminder.friend_id = ?
       AND mapping.tenant_id = ?
     ORDER BY friendReminder.target_date ASC
  `).bind(friendId, tenantId).all<FriendReminderRow>();
  return result.results;
}

export async function getFriendReminderById(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<FriendReminderWithAccountRow | null> {
  return db.prepare(`
    SELECT friendReminder.*, reminder.line_account_id AS line_account_id
      FROM friend_reminders AS friendReminder
      INNER JOIN reminders AS reminder
              ON reminder.id = friendReminder.reminder_id
             AND reminder.line_account_id IS NOT NULL
      INNER JOIN friends AS friend
              ON friend.id = friendReminder.friend_id
             AND friend.line_account_id = reminder.line_account_id
      INNER JOIN tenant_line_accounts AS mapping
              ON mapping.line_account_id = reminder.line_account_id
      INNER JOIN line_accounts AS account
              ON account.id = reminder.line_account_id
             AND account.is_active = 1
      INNER JOIN tenants AS tenant
              ON tenant.id = mapping.tenant_id
             AND tenant.status = 'active'
     WHERE friendReminder.id = ?
       AND mapping.tenant_id = ?
     LIMIT 1
  `).bind(id, tenantId).first<FriendReminderWithAccountRow>();
}

export async function cancelFriendReminder(
  db: D1Database,
  id: string,
  scope: ReminderWriteScope,
): Promise<boolean> {
  const updated = await db.prepare(`
    UPDATE friend_reminders
       SET status = 'cancelled', updated_at = ?
     WHERE friend_reminders.id = ?
       AND EXISTS (
         SELECT 1
           FROM reminders AS reminder
           INNER JOIN friends AS friend
                   ON friend.id = friend_reminders.friend_id
                  AND friend.line_account_id = reminder.line_account_id
           INNER JOIN tenant_line_accounts AS mapping
                   ON mapping.line_account_id = reminder.line_account_id
           INNER JOIN line_accounts AS account
                   ON account.id = reminder.line_account_id
                  AND account.is_active = 1
           INNER JOIN tenants AS tenant
                   ON tenant.id = mapping.tenant_id
                  AND tenant.status = 'active'
           INNER JOIN tenant_staff_memberships AS membership
                   ON membership.tenant_id = mapping.tenant_id
                  AND membership.staff_id = ?
                  AND membership.is_active = 1
           INNER JOIN staff_members AS staff
                   ON staff.id = membership.staff_id
                  AND staff.is_active = 1
          WHERE reminder.id = friend_reminders.reminder_id
            AND reminder.line_account_id IS NOT NULL
            AND mapping.tenant_id = ?
       )
  `).bind(jstNow(), id, scope.staffId, scope.tenantId).run();
  return (updated.meta?.changes ?? 0) === 1;
}

/** リマインダ配信処理用: 配信が必要な友だちリマインダを取得 */
export async function getDueReminderDeliveries(
  db: D1Database,
  now: string,
): Promise<Array<FriendReminderRow & { steps: ReminderStepRow[] }>> {
  // activeなリマインダ登録を取得
  const activeReminders = await db
    .prepare(`SELECT friendReminder.*, mapping.tenant_id AS tenant_id
                FROM friend_reminders AS friendReminder
                INNER JOIN reminders AS reminder
                        ON reminder.id = friendReminder.reminder_id
                INNER JOIN friends AS friend
                        ON friend.id = friendReminder.friend_id
                       AND friend.line_account_id = reminder.line_account_id
                INNER JOIN line_accounts AS account
                        ON account.id = reminder.line_account_id
                       AND account.is_active = 1
                INNER JOIN tenant_line_accounts AS mapping
                        ON mapping.line_account_id = reminder.line_account_id
                INNER JOIN tenants AS tenant
                        ON tenant.id = mapping.tenant_id
                       AND tenant.status = 'active'
               WHERE friendReminder.status = 'active'
                 AND reminder.is_active = 1
                 AND reminder.line_account_id IS NOT NULL`)
    .all<FriendReminderRow & { tenant_id: string }>();

  const results: Array<FriendReminderRow & { steps: ReminderStepRow[] }> = [];
  for (const row of activeReminders.results) {
    const { tenant_id: tenantId, ...friendReminder } = row;
    const steps = await getReminderSteps(db, friendReminder.reminder_id, tenantId);
    // 配信済みステップを取得
    const delivered = await db
      .prepare(`SELECT reminder_step_id FROM friend_reminder_deliveries WHERE friend_reminder_id = ?`)
      .bind(friendReminder.id)
      .all<{ reminder_step_id: string }>();
    const deliveredIds = new Set(delivered.results.map((d) => d.reminder_step_id));

    // 未配信で配信時刻が到来しているステップをフィルタ
    const dueSteps = steps.filter((step) => {
      if (deliveredIds.has(step.id)) return false;
      const targetTime = new Date(friendReminder.target_date).getTime() + step.offset_minutes * 60_000;
      return targetTime <= new Date(now).getTime();
    });

    if (dueSteps.length > 0) {
      results.push({ ...friendReminder, steps: dueSteps });
    }
  }
  return results;
}

/** 配信済みを記録 */
export async function markReminderStepDelivered(db: D1Database, friendReminderId: string, reminderStepId: string): Promise<void> {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT OR IGNORE INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id) VALUES (?, ?, ?)`)
    .bind(id, friendReminderId, reminderStepId).run();
}

/** 全ステップ配信済みならcompletedにする */
export async function completeReminderIfDone(db: D1Database, friendReminderId: string, reminderId: string): Promise<void> {
  const totalSteps = await db.prepare(`SELECT COUNT(*) as count FROM reminder_steps WHERE reminder_id = ?`)
    .bind(reminderId).first<{ count: number }>();
  const deliveredSteps = await db.prepare(`SELECT COUNT(*) as count FROM friend_reminder_deliveries WHERE friend_reminder_id = ?`)
    .bind(friendReminderId).first<{ count: number }>();

  if (totalSteps && deliveredSteps && deliveredSteps.count >= totalSteps.count) {
    await db.prepare(`UPDATE friend_reminders SET status = 'completed', updated_at = ? WHERE id = ?`)
      .bind(jstNow(), friendReminderId).run();
  }
}
