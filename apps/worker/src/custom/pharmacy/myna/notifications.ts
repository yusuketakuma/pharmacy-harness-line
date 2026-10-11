import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';
import { getPharmacyBetaNotificationBinding } from '../beta-membership/repository.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';
import type { MynaHandoff } from './repository.js';
import type { MynaHandoffStatus } from './state.js';

const NOTIFIED_STATUSES = new Set<MynaHandoffStatus>(['SUPPORT_NEEDED', 'PAPER_FALLBACK', 'EXPIRED']);

import {
  claimStatusNotificationWorks,
  expireStatusNotificationWorks,
  finishStatusNotificationWorks,
  type StatusWorkSettlement,
  type StatusNotificationWork,
} from '../status-notification-work.js';

const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;

function isQuietHours(now: Date): boolean {
  const localHour = new Date(now.getTime() + JST_OFFSET_MS).getUTCHours();
  return localHour < 8 || localHour >= 21;
}

export interface MynaNotificationOptions {
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  lineCredentialKey?: string;
  now?: Date;
  workClaim?: { retryKey: string; token: string };
}

type NotifiableHandoff = Pick<MynaHandoff, 'id' | 'line_account_id' | 'friend_id' | 'patient_id' | 'status'>;

/**
 * Patient-initiated handoffs notify on `transactional_care` — the standard
 * pipeline guards (friend following, patient notification preference, beta
 * binding) apply. There is no handoff-specific consent column; the patient
 * started the flow, mirroring the support path's own notifications.
 */
export async function sendMynaHandoffStatusNotification(
  db: D1Database,
  options: MynaNotificationOptions,
  handoff: NotifiableHandoff,
): Promise<'sent' | 'failed' | 'skipped'> {
  if (!NOTIFIED_STATUSES.has(handoff.status)) return 'skipped';
  const recipient = await db
    .prepare(
      `SELECT friend.provider_line_user_id AS line_user_id,
            mapping.tenant_id AS tenant_id
       FROM friends AS friend
       INNER JOIN pharmacy_myna_handoffs current_handoff
               ON current_handoff.id = ?
              AND current_handoff.line_account_id = friend.line_account_id
              AND current_handoff.friend_id = friend.id
              AND current_handoff.status = ?
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = friend.line_account_id
      WHERE friend.id = ? AND friend.line_account_id = ?
        ${
          options.workClaim
            ? `AND EXISTS (
          SELECT 1 FROM pharmacy_status_notification_work work
           WHERE work.line_account_id = friend.line_account_id AND work.retry_key = ?
             AND work.state = 'pending' AND work.claim_token = ? AND work.due_at > ?
             AND work.expires_at >= ?
        )`
            : ''
        }
      LIMIT 1`,
    )
    .bind(
      handoff.id,
      handoff.status,
      handoff.friend_id,
      handoff.line_account_id,
      ...(options.workClaim
        ? [options.workClaim.retryKey, options.workClaim.token, new Date().toISOString(), new Date().toISOString()]
        : []),
    )
    .first<{ line_user_id: string | null; tenant_id: string }>();
  const accessToken =
    options.lineCredentialKey && recipient
      ? await readLineCredential(db, options.lineCredentialKey, {
          tenantId: recipient.tenant_id,
          lineAccountId: handoff.line_account_id,
          kind: 'channel_access_token',
        }).catch(() => null)
      : null;
  if (!recipient?.line_user_id || !accessToken) return 'skipped';
  const retryKey = `myna-status:${handoff.id}:${handoff.status}`;
  try {
    const betaMembershipId = handoff.patient_id
      ? await getPharmacyBetaNotificationBinding(db, {
          lineAccountId: handoff.line_account_id,
          retryKey,
          participantFriendId: handoff.friend_id,
          subjectPatientId: handoff.patient_id,
        })
      : null;
    const outcome = await sendPharmacyAutomatedPush({
      db,
      proxyBaseUrl: options.proxyBaseUrl,
      proxyDispatch: options.proxyDispatch,
      accessToken,
      to: recipient.line_user_id,
      lineAccountId: handoff.line_account_id,
      friendId: handoff.friend_id,
      ...(handoff.patient_id ? { patientId: handoff.patient_id } : {}),
      ...(betaMembershipId ? { betaMembershipId } : {}),
      messageId: 'myna_handoff_status_v1',
      category: 'transactional_care',
      vars: {
        handoffStatus: handoff.status as 'EXPIRED' | 'SUPPORT_NEEDED' | 'PAPER_FALLBACK',
      },
      retryKey,
      now: options.now,
    });
    return outcome === 'sent' || outcome === 'already_sent' ? 'sent' : 'skipped';
  } catch {
    return 'failed';
  }
}

/**
 * EXPIRED is materialized lazily inside other repository calls, so a sweep
 * drains durable work created atomically by the expiry transition.
 * Retry keys are `myna-status:{id}:EXPIRED` — deterministic per handoff, so
 * repeat sweeps dedupe through the notification-events idempotency claim.
 *
 * JST 21:00–08:00 is quiet time, matching the appointment reminders and the
 * emergency-intake status sweep: expired rows stay unsent until the next
 * tick after 08:00 inside the 72 h window.
 */
export async function processExpiredMynaHandoffNotifications(
  db: D1Database,
  options: MynaNotificationOptions & { now?: Date; limit?: number },
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (isQuietHours(now)) return result;
  await expireStatusNotificationWorks(db, 'myna', now);
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = await db
    .prepare(
      `SELECT handoff.id, handoff.line_account_id, handoff.friend_id, handoff.patient_id, handoff.status,
              work.retry_key AS work_retry_key, work.attempt_count AS work_attempt_count,
              work.expires_at AS work_expires_at
       FROM pharmacy_status_notification_work work
       CROSS JOIN pharmacy_myna_handoffs handoff
         ON handoff.id = work.source_id AND handoff.line_account_id = work.line_account_id
      WHERE work.kind = 'myna' AND work.state = 'pending' AND work.due_at <= ?
        AND handoff.status = 'EXPIRED'
      ORDER BY work.due_at, work.source_id
      LIMIT ?`,
    )
    .bind(now.toISOString(), limit)
    .all<NotifiableHandoff & StatusNotificationWork>();
  const candidates = rows.results ?? [];
  const tokens = await claimStatusNotificationWorks(db, candidates, now);
  const settlements: StatusWorkSettlement[] = [];
  for (const [index, handoff] of candidates.entries()) {
    const token = tokens[index];
    if (!token) continue;
    const outcome = await sendMynaHandoffStatusNotification(
      db,
      { ...options, now, workClaim: { retryKey: handoff.work_retry_key, token } },
      handoff,
    );
    settlements.push({ row: handoff, token, outcome });
    result[outcome] += 1;
  }
  await finishStatusNotificationWorks(db, settlements, now);
  return result;
}
