import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';
import { getPharmacyBetaNotificationBinding } from '../beta-membership/repository.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';
import type { MynaHandoff } from './repository.js';
import type { MynaHandoffStatus } from './state.js';

const NOTIFIED_STATUSES = new Set<MynaHandoffStatus>([
  'SUPPORT_NEEDED', 'PAPER_FALLBACK', 'EXPIRED',
]);

export interface MynaNotificationOptions {
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  lineCredentialKey?: string;
}

type NotifiableHandoff = Pick<
  MynaHandoff,
  'id' | 'line_account_id' | 'friend_id' | 'patient_id' | 'status'
>;

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
  const recipient = await db.prepare(
    `SELECT friend.provider_line_user_id AS line_user_id,
            mapping.tenant_id AS tenant_id
       FROM friends AS friend
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = friend.line_account_id
      WHERE friend.id = ? AND friend.line_account_id = ?
      LIMIT 1`,
  ).bind(handoff.friend_id, handoff.line_account_id)
    .first<{ line_user_id: string | null; tenant_id: string }>();
  const accessToken = options.lineCredentialKey && recipient
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
    });
    return outcome === 'sent' || outcome === 'already_sent' ? 'sent' : 'skipped';
  } catch {
    return 'failed';
  }
}

/**
 * EXPIRED is materialized lazily inside other repository calls, so a sweep
 * delivers the one push a non-returning patient would otherwise never get.
 * Retry keys are `myna-status:{id}:EXPIRED` — deterministic per handoff, so
 * repeat sweeps dedupe through the notification-events idempotency claim.
 */
export async function processExpiredMynaHandoffNotifications(
  db: D1Database,
  options: MynaNotificationOptions & { now?: Date; limit?: number },
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const lookback = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = await db.prepare(
    `SELECT id, line_account_id, friend_id, patient_id, status
       FROM pharmacy_myna_handoffs
      WHERE status = 'EXPIRED' AND updated_at >= ?
      ORDER BY updated_at ASC, id ASC
      LIMIT ?`,
  ).bind(lookback, limit).all<NotifiableHandoff>();
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const handoff of rows.results ?? []) {
    result[await sendMynaHandoffStatusNotification(db, options, handoff)] += 1;
  }
  return result;
}
