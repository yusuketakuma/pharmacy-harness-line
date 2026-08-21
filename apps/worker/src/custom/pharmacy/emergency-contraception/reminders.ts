const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const CLAIM_TTL_MS = 15 * 60 * 1000;

export type EmergencyReminderControl = {
  state: 'inactive' | 'active' | 'frozen';
  revision: number;
  timeZone: 'Asia/Tokyo';
  updatedAt: string | null;
};

export async function getEmergencyReminderControl(
  db: D1Database,
  lineAccountId: string,
): Promise<EmergencyReminderControl> {
  const row = await db.prepare(
    `SELECT state, revision, time_zone, updated_at
       FROM pharmacy_emergency_reminder_controls
      WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{
    state: EmergencyReminderControl['state'];
    revision: number;
    time_zone: 'Asia/Tokyo';
    updated_at: string;
  }>();
  return row ? {
    state: row.state,
    revision: row.revision,
    timeZone: row.time_zone,
    updatedAt: row.updated_at,
  } : { state: 'inactive', revision: 0, timeZone: 'Asia/Tokyo', updatedAt: null };
}

export async function saveEmergencyReminderControl(
  db: D1Database,
  input: {
    lineAccountId: string;
    staffId: string;
    state: EmergencyReminderControl['state'];
    expectedRevision: number;
    now?: Date;
  },
): Promise<EmergencyReminderControl> {
  if (!input.lineAccountId || !input.staffId ||
      !['inactive', 'active', 'frozen'].includes(input.state) ||
      !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error('invalid emergency reminder control');
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  try {
    const result = input.expectedRevision === 0
      ? await db.prepare(
        `INSERT INTO pharmacy_emergency_reminder_controls
          (line_account_id, state, time_zone, revision, updated_by, created_at, updated_at)
         VALUES (?, ?, 'Asia/Tokyo', 1, ?, ?, ?)`,
      ).bind(input.lineAccountId, input.state, input.staffId, timestamp, timestamp).run()
      : await db.prepare(
        `UPDATE pharmacy_emergency_reminder_controls
            SET state = ?, revision = revision + 1, updated_by = ?, updated_at = ?
          WHERE line_account_id = ? AND revision = ?`,
      ).bind(
        input.state, input.staffId, timestamp, input.lineAccountId, input.expectedRevision,
      ).run();
    if ((result.meta.changes ?? 0) !== 1) throw new Error('stale emergency reminder revision');
  } catch (error) {
    if (input.expectedRevision === 0 && /unique|constraint/i.test(String(error))) {
      throw new Error('stale emergency reminder revision');
    }
    throw error;
  }
  return {
    state: input.state,
    revision: input.expectedRevision + 1,
    timeZone: 'Asia/Tokyo',
    updatedAt: timestamp,
  };
}

export type EmergencyAppointmentReminder = {
  id: string;
  line_account_id: string;
  intake_id: string;
  anchor_at: string;
  due_at: string;
  deadline_at: string;
  occurrence_hash: string;
  claim_token: string;
};

export function appointmentReminderSchedule(anchorAt: string): {
  dueAt: string;
  deadlineAt: string;
  suppressionReason: 'QUIET_HOURS_PAST_DEADLINE' | null;
} {
  const anchor = new Date(anchorAt);
  if (!Number.isFinite(anchor.getTime())) throw new Error('invalid reminder anchor');

  const originalDue = new Date(anchor.getTime() - HOUR_MS);
  const localDue = new Date(originalDue.getTime() + JST_OFFSET_MS);
  const hour = localDue.getUTCHours();
  let due = originalDue;

  // ponytail: v0.30 supports Japan accounts only; add IANA zones when another region is onboarded.
  if (hour < 8) {
    due = new Date(Date.UTC(
      localDue.getUTCFullYear(), localDue.getUTCMonth(), localDue.getUTCDate(), 8,
    ) - JST_OFFSET_MS);
  } else if (hour >= 21) {
    due = new Date(Date.UTC(
      localDue.getUTCFullYear(), localDue.getUTCMonth(), localDue.getUTCDate() + 1, 8,
    ) - JST_OFFSET_MS);
  }

  return {
    dueAt: (due.getTime() < anchor.getTime() ? due : originalDue).toISOString(),
    deadlineAt: anchor.toISOString(),
    suppressionReason: due.getTime() < anchor.getTime() ? null : 'QUIET_HOURS_PAST_DEADLINE',
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function generateEmergencyAppointmentReminders(
  db: D1Database,
  input: { now?: Date; limit?: number } = {},
): Promise<{ generated: number; suppressed: number; failed: number }> {
  const now = input.now ?? new Date();
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const rows = await db.prepare(
    `SELECT intake.id AS intake_id, intake.tenant_id, intake.line_account_id,
            slot.starts_at AS anchor_at
       FROM pharmacy_emergency_intakes AS intake
       INNER JOIN pharmacy_emergency_slots AS slot
         ON slot.id = intake.slot_id AND slot.line_account_id = intake.line_account_id
       INNER JOIN pharmacy_emergency_settings AS settings
         ON settings.line_account_id = intake.line_account_id AND settings.is_enabled = 1
       INNER JOIN pharmacy_emergency_reminder_controls AS control
         ON control.line_account_id = intake.line_account_id AND control.state = 'active'
       INNER JOIN pharmacy_account_capabilities AS capability
         ON capability.line_account_id = intake.line_account_id AND capability.mode = 'pharmacy'
        AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                     WHERE value = 'emergency_contraception')
       INNER JOIN line_accounts AS account
         ON account.id = intake.line_account_id AND account.is_active = 1
       INNER JOIN tenants AS tenant ON tenant.id = intake.tenant_id AND tenant.status = 'active'
      WHERE intake.status IN ('provisional', 'reviewed')
        AND intake.safe_contact_mode = 'neutral_line'
        AND intake.expires_at > ? AND slot.starts_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_emergency_reminders AS reminder
           WHERE reminder.line_account_id = intake.line_account_id
             AND reminder.intake_id = intake.id
             AND reminder.reminder_kind = 'appointment_neutral_v1'
             AND reminder.anchor_at = slot.starts_at
        )
      ORDER BY slot.starts_at, intake.line_account_id, intake.id
      LIMIT ?`,
  ).bind(now.toISOString(), now.toISOString(), limit).all<{
    intake_id: string;
    tenant_id: string;
    line_account_id: string;
    anchor_at: string;
  }>();

  let generated = 0;
  let suppressed = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      const schedule = appointmentReminderSchedule(row.anchor_at);
      const occurrenceHash = await sha256([
        row.tenant_id, row.line_account_id, row.intake_id,
        'appointment_neutral_v1', schedule.deadlineAt,
      ].join(':'));
      const status = schedule.suppressionReason ? 'suppressed' : 'pending';
      const result = await db.prepare(
        `INSERT OR IGNORE INTO pharmacy_emergency_reminders
          (id, line_account_id, intake_id, reminder_kind, anchor_at, due_at,
           deadline_at, occurrence_hash, status, reason_code, created_at, updated_at)
         VALUES (?, ?, ?, 'appointment_neutral_v1', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), row.line_account_id, row.intake_id, schedule.deadlineAt,
        schedule.dueAt, schedule.deadlineAt, occurrenceHash, status,
        schedule.suppressionReason, now.toISOString(), now.toISOString(),
      ).run();
      if ((result.meta.changes ?? 0) > 0) {
        if (status === 'suppressed') suppressed += 1;
        else generated += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { generated, suppressed, failed };
}

export async function claimDueEmergencyAppointmentReminders(
  db: D1Database,
  now = new Date(),
  limit = 50,
): Promise<EmergencyAppointmentReminder[]> {
  const timestamp = now.toISOString();
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  await db.prepare(
    `UPDATE pharmacy_emergency_reminders
        SET status = 'suppressed', reason_code = 'DEADLINE_PASSED',
            claim_token = NULL, claimed_at = NULL, updated_at = ?
      WHERE status IN ('pending', 'failed', 'processing') AND deadline_at <= ?`,
  ).bind(timestamp, timestamp).run();

  const claimToken = crypto.randomUUID();
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  const claimed = await db.prepare(
    `UPDATE pharmacy_emergency_reminders
        SET status = 'processing', claim_token = ?, claimed_at = ?,
            reason_code = NULL, attempt_count = attempt_count + 1, updated_at = ?
      WHERE id IN (
        SELECT id FROM pharmacy_emergency_reminders
         WHERE due_at <= ? AND deadline_at > ?
           AND (status IN ('pending', 'failed')
             OR (status = 'processing' AND claimed_at < ?))
         ORDER BY due_at, line_account_id, id LIMIT ?
      )
      RETURNING id, line_account_id, intake_id, anchor_at, due_at, deadline_at,
                occurrence_hash, claim_token`,
  ).bind(
    claimToken, timestamp, timestamp, timestamp, timestamp, staleBefore, boundedLimit,
  ).all<EmergencyAppointmentReminder>();
  return claimed.results ?? [];
}
