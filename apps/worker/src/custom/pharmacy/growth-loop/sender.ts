import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { createLineRetryKey } from '../../../services/broadcast-retry-key.js';
import {
  LineHarnessUnknownOutcomeError,
  pushViaHarnessProxy,
} from '../../../services/line-proxy-send.js';
import { getPharmacyCapabilityConfig } from './repository.js';
import { getPatientAccessState } from '../intake/repository.js';
import {
  buildApprovedPharmacyMessage,
  type PharmacyAutomatedMessageId,
  type PharmacyMessageVars,
  type PharmacyNotificationCategory,
} from './policy.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LINE_RETRY_KEY_HORIZON_MS = 24 * 60 * 60 * 1000;

type AutomatedPushInput = {
  db: D1Database;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  accessToken: string;
  to: string;
  lineAccountId: string;
  friendId: string;
  patientId?: string;
  messageId: PharmacyAutomatedMessageId;
  category: Exclude<PharmacyNotificationCategory, 'manual'>;
  vars?: PharmacyMessageVars;
  retryKey: string;
  now?: Date;
};

export type PharmacyPushResult =
  | 'sent'
  | 'already_sent'
  | 'in_progress'
  | 'reconciliation_required'
  | 'patient_blocked'
  | 'paused';

function jstMonthBounds(now: Date): { from: string; to: string } {
  const local = new Date(now.getTime() + JST_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS).toISOString(),
    to: new Date(Date.UTC(year, month + 1, 1) - JST_OFFSET_MS).toISOString(),
  };
}

async function markOutcome(
  db: D1Database,
  lineAccountId: string,
  retryKey: string,
  outcome: 'sent' | 'failed' | 'blocked',
  occurredAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE pharmacy_notification_events
        SET outcome = ?, occurred_at = ?
      WHERE line_account_id = ? AND idempotency_key = ? AND outcome <> 'sent'`,
  ).bind(outcome, occurredAt, lineAccountId, retryKey).run();
}

async function recordBlocked(input: AutomatedPushInput, occurredAt: string): Promise<void> {
  await input.db.prepare(
    `INSERT OR IGNORE INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome,
       schema_version, occurred_at, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'blocked', 1, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.lineAccountId, input.friendId, input.messageId,
    input.category, occurredAt, input.retryKey, occurredAt,
  ).run();
  await input.db.prepare(
    `UPDATE pharmacy_notification_events
        SET outcome = 'blocked', occurred_at = ?
      WHERE line_account_id = ? AND idempotency_key = ?
        AND outcome IN ('attempted','failed')`,
  ).bind(occurredAt, input.lineAccountId, input.retryKey).run();
}

async function canDeliverToPatient(input: AutomatedPushInput): Promise<boolean> {
  if (!input.patientId) return true;
  const access = await getPatientAccessState(input.db, {
    lineAccountId: input.lineAccountId,
    friendId: input.friendId,
  }, input.patientId);
  return access?.notifications === 'enabled';
}

export async function sendPharmacyAutomatedPush(
  input: AutomatedPushInput,
): Promise<PharmacyPushResult> {
  if (!input.db || !input.lineAccountId || !input.friendId) {
    throw new Error('pharmacy notification account context is required');
  }

  const message = buildApprovedPharmacyMessage(input.messageId, input.vars);
  const accountConfig = await getPharmacyCapabilityConfig(input.db, input.lineAccountId);
  const requiredCapability = input.messageId === 'continuity_reminder_v1'
    ? 'continuity'
    : input.messageId === 'medication_followup_v1'
      ? 'medication_followup'
      : input.messageId === 'appointment_reminder_v1'
        ? 'emergency_contraception'
      : 'prescription_intake';
  if (!accountConfig || !accountConfig.capabilities.includes(requiredCapability)) {
    throw new Error('pharmacy notification capability is not enabled');
  }

  // Outbound pause is checked here, the one choke point every pharmacy
  // proactive push routes through, and BEFORE the idempotency claim below:
  // a paused send must not burn the retry key or the proactive monthly cap,
  // so the same message can still go out once the tenant is unpaused.
  // Inbound webhook processing is deliberately unaffected — a paused tenant
  // still receives and stores everything.
  const pausedRow = await input.db.prepare(
    `SELECT tenant.outbound_messaging_paused_at
       FROM tenant_line_accounts AS mapping
       INNER JOIN tenants AS tenant ON tenant.id = mapping.tenant_id
      WHERE mapping.line_account_id = ?
      LIMIT 1`,
  ).bind(input.lineAccountId).first<{ outbound_messaging_paused_at: string | null }>();
  if (pausedRow?.outbound_messaging_paused_at) {
    console.log(
      `[pharmacy-notification] skipped, not sent — outbound messaging paused since ${pausedRow.outbound_messaging_paused_at} ` +
      `(line_account=${input.lineAccountId} message=${input.messageId})`,
    );
    return 'paused';
  }

  const now = input.now ?? new Date();
  const occurredAt = now.toISOString();
  const staleAttemptAt = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const retryHorizonStart = new Date(now.getTime() - LINE_RETRY_KEY_HORIZON_MS).toISOString();
  const month = jstMonthBounds(now);
  const notificationEventId = crypto.randomUUID();
  let dispatchEventId = notificationEventId;
  if (!(await canDeliverToPatient(input))) {
    await recordBlocked(input, occurredAt);
    return 'patient_blocked';
  }
  const claim = await input.db.prepare(
    `INSERT OR IGNORE INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome,
       schema_version, occurred_at, idempotency_key, created_at)
     SELECT ?, ?, ?, ?, ?, 'attempted', 1, ?, ?, ?
      WHERE ? <> 'proactive_noncare' OR (
        SELECT COUNT(*) FROM pharmacy_notification_events
         WHERE line_account_id = ? AND friend_id = ?
           AND category = 'proactive_noncare'
           AND outcome IN ('attempted','sent')
           AND occurred_at >= ? AND occurred_at < ?
      ) < ?`,
  ).bind(
    notificationEventId, input.lineAccountId, input.friendId, input.messageId,
    input.category, occurredAt, input.retryKey, occurredAt,
    input.category, input.lineAccountId, input.friendId, month.from, month.to,
    accountConfig.proactive_monthly_limit,
  ).run();

  if ((claim.meta?.changes ?? 0) !== 1) {
    const existing = await input.db.prepare(
      `SELECT id, outcome, occurred_at, created_at FROM pharmacy_notification_events
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(input.lineAccountId, input.retryKey).first<{
      id: string; outcome: string; occurred_at: string; created_at?: string;
    }>();
    if (existing?.outcome === 'sent') return 'already_sent';
    if (existing?.outcome === 'blocked') {
      throw new Error('pharmacy proactive frequency cap reached');
    }
    if (existing?.outcome === 'attempted') {
      if ((existing.created_at ?? existing.occurred_at) <= retryHorizonStart) {
        return 'reconciliation_required';
      }
      if (existing.occurred_at >= staleAttemptAt) return 'in_progress';
      const reclaimed = await input.db.prepare(
        `UPDATE pharmacy_notification_events
            SET occurred_at = ?
          WHERE line_account_id = ? AND idempotency_key = ?
            AND outcome = 'attempted' AND occurred_at < ?`,
      ).bind(occurredAt, input.lineAccountId, input.retryKey, staleAttemptAt).run();
      if ((reclaimed.meta?.changes ?? 0) !== 1) return 'in_progress';
      dispatchEventId = existing.id;
    } else if (existing?.outcome === 'failed') {
      const reclaimed = await input.db.prepare(
        `UPDATE pharmacy_notification_events
            SET outcome = 'attempted', occurred_at = ?
          WHERE line_account_id = ? AND idempotency_key = ? AND outcome = 'failed'
            AND (? <> 'proactive_noncare' OR (
              SELECT COUNT(*) FROM pharmacy_notification_events
               WHERE line_account_id = ? AND friend_id = ?
                 AND category = 'proactive_noncare'
                 AND outcome IN ('attempted','sent')
                 AND occurred_at >= ? AND occurred_at < ?
            ) < ?)`,
      ).bind(
        occurredAt, input.lineAccountId, input.retryKey, input.category,
        input.lineAccountId, input.friendId, month.from, month.to,
        accountConfig.proactive_monthly_limit,
      ).run();
      if ((reclaimed.meta?.changes ?? 0) !== 1) {
        await input.db.prepare(
          `UPDATE pharmacy_notification_events SET outcome = 'blocked', occurred_at = ?
            WHERE line_account_id = ? AND idempotency_key = ? AND outcome = 'failed'`,
        ).bind(occurredAt, input.lineAccountId, input.retryKey).run();
        throw new Error('pharmacy proactive frequency cap reached');
      }
      dispatchEventId = existing.id;
    } else {
      await recordBlocked(input, occurredAt);
      throw new Error('pharmacy proactive frequency cap reached');
    }
  }

  if (!(await canDeliverToPatient(input))) {
    await markOutcome(input.db, input.lineAccountId, input.retryKey, 'blocked', new Date().toISOString());
    return 'patient_blocked';
  }

  try {
    await pushViaHarnessProxy(
      input.proxyBaseUrl,
      input.accessToken,
      input.to,
      [message],
      await createLineRetryKey(input.retryKey),
      input.proxyDispatch,
      {
        pharmacyNotificationEventId: dispatchEventId,
        lineAccountId: input.lineAccountId,
      },
    );
  } catch (error) {
    if (error instanceof LineHarnessUnknownOutcomeError) throw error;
    await markOutcome(input.db, input.lineAccountId, input.retryKey, 'failed', new Date().toISOString());
    throw error;
  }

  // LINE accepted the stable retry key. If this D1 finalization fails, leave
  // the row attempted so the stale retry reconciles with that same key.
  await markOutcome(input.db, input.lineAccountId, input.retryKey, 'sent', new Date().toISOString());
  return 'sent';
}
