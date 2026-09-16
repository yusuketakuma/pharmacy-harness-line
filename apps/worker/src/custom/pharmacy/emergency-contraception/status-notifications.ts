import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';

const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const LOOKBACK_MS = 72 * HOUR_MS;

const NOTIFIED_EVENT_TYPES = ['reviewed', 'cancelled', 'expired'] as const;
type NotifiedIntakeStatus = (typeof NOTIFIED_EVENT_TYPES)[number];

type StatusNotificationRow = {
  event_id: string;
  intake_status: NotifiedIntakeStatus;
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
  safe_contact_mode: string;
};

function isQuietHours(now: Date): boolean {
  const localHour = new Date(now.getTime() + JST_OFFSET_MS).getUTCHours();
  return localHour < 8 || localHour >= 21;
}

/**
 * Sweeps emergency intake transition events and pushes one neutral LINE
 * notification per reviewed/cancelled/expired transition. Event-driven
 * hooks would need every transition site wired; reading
 * `pharmacy_emergency_intake_events` catches staff transitions and the
 * lazy 'expired' materialization uniformly.
 *
 * Consent and suppression mirror the appointment-reminder rules:
 * `safe_contact_mode = 'neutral_line'` is the patient's explicit LINE
 * contact consent (immutable on the intake), while settings.is_enabled,
 * reminder_controls.state, capability, and account/tenant state are
 * re-checked each tick — a frozen or disabled account simply keeps
 * skipping until the 72 h lookback ages the event out. Retry keys are the
 * intake event ids, so successful sends dedupe through the notification
 * events idempotency claim.
 *
 * JST 21:00–08:00 is quiet time (same window as appointment reminders):
 * events stay unsent until the next tick after 08:00, when the notice
 * still reads correctly the following morning.
 */
export async function processEmergencyIntakeStatusNotifications(
  db: D1Database,
  options: {
    proxyBaseUrl: string;
    proxyDispatch?: HarnessProxyDispatch;
    lineCredentialKey?: string;
    now?: Date;
    limit?: number;
  },
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (isQuietHours(now)) return result;

  const lookback = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = await db.prepare(
    `SELECT event.id AS event_id, event.event_type AS intake_status,
            intake.tenant_id, intake.line_account_id,
            intake.owner_friend_id AS friend_id, intake.safe_contact_mode,
            friend.provider_line_user_id AS line_user_id, friend.is_following,
            control.state AS control_state,
            COALESCE(settings.is_enabled, 0) AS feature_enabled,
            EXISTS (
              SELECT 1 FROM pharmacy_account_capabilities AS capability
               WHERE capability.line_account_id = intake.line_account_id
                 AND capability.mode = 'pharmacy'
                 AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                              WHERE value = 'emergency_contraception')
            ) AS capability_enabled,
            account.is_active AS account_active, tenant.status AS tenant_status
       FROM pharmacy_emergency_intake_events AS event
       INNER JOIN pharmacy_emergency_intakes AS intake
         ON intake.id = event.intake_id AND intake.line_account_id = event.line_account_id
       INNER JOIN friends AS friend
         ON friend.id = intake.owner_friend_id AND friend.line_account_id = intake.line_account_id
       INNER JOIN line_accounts AS account ON account.id = intake.line_account_id
       INNER JOIN tenants AS tenant ON tenant.id = intake.tenant_id
       LEFT JOIN pharmacy_emergency_settings AS settings
         ON settings.line_account_id = intake.line_account_id
       LEFT JOIN pharmacy_emergency_reminder_controls AS control
         ON control.line_account_id = intake.line_account_id
      WHERE event.event_type IN ('reviewed', 'cancelled', 'expired')
        AND event.occurred_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_notification_events AS notice
           WHERE notice.line_account_id = event.line_account_id
             AND notice.idempotency_key = 'emergency-intake-status:' || event.id
             AND notice.outcome = 'sent'
        )
      ORDER BY event.occurred_at ASC, event.id ASC
      LIMIT ?`,
  ).bind(lookback, limit).all<StatusNotificationRow>();

  for (const row of rows.results ?? []) {
    if (row.control_state !== 'active' || row.account_active !== 1 ||
        row.tenant_status !== 'active' || row.feature_enabled !== 1 ||
        row.capability_enabled !== 1 ||
        row.safe_contact_mode !== 'neutral_line' ||
        row.is_following !== 1 || !row.line_user_id) {
      result.skipped += 1;
      continue;
    }
    const accessToken = options.lineCredentialKey
      ? await readLineCredential(db, options.lineCredentialKey, {
        tenantId: row.tenant_id,
        lineAccountId: row.line_account_id,
        kind: 'channel_access_token',
      }).catch(() => null)
      : null;
    if (!accessToken) {
      result.skipped += 1;
      continue;
    }
    try {
      const outcome = await sendPharmacyAutomatedPush({
        db,
        proxyBaseUrl: options.proxyBaseUrl,
        proxyDispatch: options.proxyDispatch,
        accessToken,
        to: row.line_user_id,
        lineAccountId: row.line_account_id,
        friendId: row.friend_id,
        messageId: 'emergency_intake_status_v1',
        category: 'transactional_care',
        vars: { intakeStatus: row.intake_status },
        retryKey: `emergency-intake-status:${row.event_id}`,
        now,
      });
      if (outcome === 'sent' || outcome === 'already_sent') result.sent += 1;
      else result.skipped += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
