import type { Message } from '@line-crm/line-sdk';
import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { pushViaHarnessProxy } from '../../../services/line-proxy-send.js';
import { getPharmacyCapabilityConfig } from './repository.js';
import {
  buildApprovedPharmacyMessage,
  type PharmacyAutomatedMessageId,
  type PharmacyMessageVars,
  type PharmacyNotificationCategory,
} from './policy.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AutomatedPushInput = {
  db: D1Database;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  accessToken: string;
  to: string;
  lineAccountId: string;
  friendId: string;
  messageId: PharmacyAutomatedMessageId;
  category: Exclude<PharmacyNotificationCategory, 'manual'>;
  vars?: PharmacyMessageVars;
  retryKey: string;
  now?: Date;
};

export type PharmacyPushResult = 'sent' | 'already_sent';

function jstMonthBounds(now: Date): { from: string; to: string } {
  const local = new Date(now.getTime() + JST_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month, 1) - JST_OFFSET_MS).toISOString(),
    to: new Date(Date.UTC(year, month + 1, 1) - JST_OFFSET_MS).toISOString(),
  };
}

async function lineRetryKey(value: string): Promise<string> {
  if (UUID_RE.test(value)) return value.toLowerCase();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function markOutcome(
  db: D1Database,
  lineAccountId: string,
  retryKey: string,
  outcome: 'sent' | 'failed',
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
    : 'prescription_intake';
  if (!accountConfig || !accountConfig.capabilities.includes(requiredCapability)) {
    throw new Error('pharmacy notification capability is not enabled');
  }

  const now = input.now ?? new Date();
  const occurredAt = now.toISOString();
  const month = jstMonthBounds(now);
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
    crypto.randomUUID(), input.lineAccountId, input.friendId, input.messageId,
    input.category, occurredAt, input.retryKey, occurredAt,
    input.category, input.lineAccountId, input.friendId, month.from, month.to,
    accountConfig.proactive_monthly_limit,
  ).run();

  if ((claim.meta?.changes ?? 0) !== 1) {
    const existing = await input.db.prepare(
      `SELECT outcome FROM pharmacy_notification_events
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(input.lineAccountId, input.retryKey).first<{ outcome: string }>();
    if (existing?.outcome === 'sent') return 'already_sent';
    if (existing?.outcome === 'blocked') {
      throw new Error('pharmacy proactive frequency cap reached');
    }
    if (existing?.outcome === 'failed') {
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
    } else if (existing?.outcome !== 'attempted') {
      await recordBlocked(input, occurredAt);
      throw new Error('pharmacy proactive frequency cap reached');
    }
  }

  try {
    await pushViaHarnessProxy(
      input.proxyBaseUrl,
      input.accessToken,
      input.to,
      [message],
      await lineRetryKey(input.retryKey),
      input.proxyDispatch,
    );
    await markOutcome(input.db, input.lineAccountId, input.retryKey, 'sent', new Date().toISOString());
    return 'sent';
  } catch (error) {
    await markOutcome(input.db, input.lineAccountId, input.retryKey, 'failed', new Date().toISOString());
    throw error;
  }
}

export function isApprovedPharmacyMessage(message: Message): boolean {
  return message.type === 'text' && typeof message.text === 'string' && message.text.length <= 500;
}
