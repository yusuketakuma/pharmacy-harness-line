import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';
import {
  claimDueEmergencyAppointmentReminders,
  generateEmergencyAppointmentReminders,
  type EmergencyAppointmentReminder,
} from './reminders.js';

type ReminderContext = {
  tenant_id: string;
  line_account_id: string;
  friend_id: string;
  line_user_id: string | null;
  is_following: number;
  control_state: string | null;
  feature_enabled: number;
  capability_enabled: number;
  account_active: number;
  tenant_status: string;
  intake_status: string;
  safe_contact_mode: string;
  expires_at: string;
  slot_starts_at: string;
};

type SuppressionReason =
  | 'ACTIVATION_DISABLED'
  | 'FEATURE_DISABLED'
  | 'CONTACT_NOT_ALLOWED'
  | 'INTAKE_INACTIVE'
  | 'INTAKE_EXPIRED'
  | 'ANCHOR_CHANGED'
  | 'DEADLINE_PASSED'
  | 'RECIPIENT_UNAVAILABLE';

async function updateClaimed(
  db: D1Database,
  reminder: EmergencyAppointmentReminder,
  sql: string,
  values: unknown[],
): Promise<boolean> {
  const result = await db.prepare(sql).bind(
    ...values, reminder.id, reminder.line_account_id, reminder.claim_token,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

async function suppress(
  db: D1Database,
  reminder: EmergencyAppointmentReminder,
  reason: SuppressionReason,
  now: string,
): Promise<boolean> {
  return updateClaimed(
    db,
    reminder,
    `UPDATE pharmacy_emergency_reminders
        SET status = 'suppressed', reason_code = ?, claim_token = NULL,
            claimed_at = NULL, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'processing' AND claim_token = ?`,
    [reason, now],
  );
}

async function releaseClaim(
  db: D1Database,
  reminder: EmergencyAppointmentReminder,
  now: string,
): Promise<boolean> {
  return updateClaimed(
    db,
    reminder,
    `UPDATE pharmacy_emergency_reminders
        SET status = 'pending', reason_code = NULL, claim_token = NULL,
            claimed_at = NULL, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'processing' AND claim_token = ?`,
    [now],
  );
}

function suppressionReason(
  context: ReminderContext | null,
  reminder: EmergencyAppointmentReminder,
  now: Date,
): SuppressionReason | null {
  if (!context) return 'INTAKE_INACTIVE';
  if (context.control_state !== 'active' || context.account_active !== 1 || context.tenant_status !== 'active') {
    return 'ACTIVATION_DISABLED';
  }
  if (context.feature_enabled !== 1 || context.capability_enabled !== 1) return 'FEATURE_DISABLED';
  if (context.safe_contact_mode !== 'neutral_line') return 'CONTACT_NOT_ALLOWED';
  if (!['provisional', 'reviewed'].includes(context.intake_status)) return 'INTAKE_INACTIVE';
  if (new Date(context.expires_at).getTime() <= now.getTime()) return 'INTAKE_EXPIRED';
  if (context.slot_starts_at !== reminder.anchor_at) return 'ANCHOR_CHANGED';
  if (new Date(reminder.deadline_at).getTime() <= now.getTime()) return 'DEADLINE_PASSED';
  if (context.is_following !== 1 || !context.line_user_id) return 'RECIPIENT_UNAVAILABLE';
  return null;
}

async function readContext(
  db: D1Database,
  reminder: EmergencyAppointmentReminder,
): Promise<ReminderContext | null> {
  return db.prepare(
    `SELECT intake.tenant_id, intake.line_account_id, intake.owner_friend_id AS friend_id,
            friend.provider_line_user_id AS line_user_id, friend.is_following,
            control.state AS control_state, COALESCE(settings.is_enabled, 0) AS feature_enabled,
            EXISTS (
              SELECT 1 FROM pharmacy_account_capabilities AS capability
               WHERE capability.line_account_id = intake.line_account_id
                 AND capability.mode = 'pharmacy'
                 AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                              WHERE value = 'emergency_contraception')
            ) AS capability_enabled,
            account.is_active AS account_active, tenant.status AS tenant_status,
            intake.status AS intake_status, intake.safe_contact_mode, intake.expires_at,
            slot.starts_at AS slot_starts_at
       FROM pharmacy_emergency_reminders AS reminder
       INNER JOIN pharmacy_emergency_intakes AS intake
         ON intake.id = reminder.intake_id AND intake.line_account_id = reminder.line_account_id
       INNER JOIN pharmacy_emergency_slots AS slot
         ON slot.id = intake.slot_id AND slot.line_account_id = intake.line_account_id
       INNER JOIN friends AS friend
         ON friend.id = intake.owner_friend_id AND friend.line_account_id = intake.line_account_id
       INNER JOIN line_accounts AS account ON account.id = intake.line_account_id
       INNER JOIN tenants AS tenant ON tenant.id = intake.tenant_id
       LEFT JOIN pharmacy_emergency_settings AS settings
         ON settings.line_account_id = intake.line_account_id
       LEFT JOIN pharmacy_emergency_reminder_controls AS control
         ON control.line_account_id = intake.line_account_id
      WHERE reminder.id = ? AND reminder.line_account_id = ?
        AND reminder.intake_id = ? AND reminder.status = 'processing'
        AND reminder.claim_token = ?
      LIMIT 1`,
  ).bind(
    reminder.id, reminder.line_account_id, reminder.intake_id, reminder.claim_token,
  ).first<ReminderContext>();
}

export async function processEmergencyAppointmentReminders(
  db: D1Database,
  options: {
    proxyBaseUrl: string;
    proxyDispatch?: HarnessProxyDispatch;
    lineCredentialKey?: string;
    now?: Date;
    limit?: number;
  },
): Promise<{ generated: number; sent: number; failed: number; skipped: number; suppressed: number }> {
  const now = options.now ?? new Date();
  const generated = await generateEmergencyAppointmentReminders(db, {
    now, limit: options.limit,
  });
  const reminders = await claimDueEmergencyAppointmentReminders(db, now, options.limit);
  const result = {
    generated: generated.generated,
    sent: 0,
    failed: generated.failed,
    skipped: 0,
    suppressed: generated.suppressed,
  };

  for (const reminder of reminders) {
    const timestamp = now.toISOString();
    let context: ReminderContext | null;
    try {
      context = await readContext(db, reminder);
    } catch {
      await releaseClaim(db, reminder, timestamp);
      result.skipped += 1;
      continue;
    }
    const reason = suppressionReason(context, reminder, now);
    if (reason) {
      if (await suppress(db, reminder, reason, timestamp)) result.suppressed += 1;
      else result.skipped += 1;
      continue;
    }

    const accessToken = options.lineCredentialKey
      ? await readLineCredential(db, options.lineCredentialKey, {
        tenantId: context!.tenant_id,
        lineAccountId: context!.line_account_id,
        kind: 'channel_access_token',
      }).catch(() => null)
      : null;
    if (!accessToken) {
      await updateClaimed(
        db,
        reminder,
        `UPDATE pharmacy_emergency_reminders
            SET status = 'failed', reason_code = 'CREDENTIAL_UNAVAILABLE',
                claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND status = 'processing' AND claim_token = ?`,
        [timestamp],
      );
      result.failed += 1;
      continue;
    }

    try {
      const outcome = await sendPharmacyAutomatedPush({
        db,
        proxyBaseUrl: options.proxyBaseUrl,
        proxyDispatch: options.proxyDispatch,
        accessToken,
        to: context!.line_user_id!,
        lineAccountId: context!.line_account_id,
        friendId: context!.friend_id,
        messageId: 'appointment_reminder_v1',
        category: 'transactional_care',
        retryKey: reminder.occurrence_hash,
        now,
      });
      if (outcome !== 'sent' && outcome !== 'already_sent') {
        await releaseClaim(db, reminder, timestamp);
        result.skipped += 1;
        continue;
      }
      if (await updateClaimed(
        db,
        reminder,
        `UPDATE pharmacy_emergency_reminders
            SET status = 'sent', sent_at = ?, reason_code = NULL,
                claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND status = 'processing' AND claim_token = ?`,
        [timestamp, timestamp],
      )) result.sent += 1;
      else result.skipped += 1;
    } catch {
      await updateClaimed(
        db,
        reminder,
        `UPDATE pharmacy_emergency_reminders
            SET status = 'failed', reason_code = 'SEND_FAILED',
                claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND status = 'processing' AND claim_token = ?`,
        [timestamp],
      );
      result.failed += 1;
    }
  }
  return result;
}
