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

export async function sendPharmacyAutomatedPush(input: {
  db?: D1Database;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
  accessToken: string;
  to: string;
  lineAccountId?: string;
  friendId?: string;
  messageId: PharmacyAutomatedMessageId;
  category: Exclude<PharmacyNotificationCategory, 'manual'>;
  vars?: PharmacyMessageVars;
  retryKey: string;
}): Promise<void> {
  const message = buildApprovedPharmacyMessage(input.messageId, input.vars);
  let accountConfig: Awaited<ReturnType<typeof getPharmacyCapabilityConfig>> = null;
  if (input.lineAccountId) {
    if (!input.db) throw new Error('pharmacy capability config database is required');
    accountConfig = await getPharmacyCapabilityConfig(input.db, input.lineAccountId);
    const requiredCapability = input.messageId === 'continuity_reminder_v1'
      ? 'continuity'
      : 'prescription_intake';
    if (!accountConfig || !accountConfig.capabilities.includes(requiredCapability)) {
      throw new Error('pharmacy notification capability is not enabled');
    }
  }
  if (input.lineAccountId && input.category === 'proactive_noncare') {
    if (!input.db) throw new Error('pharmacy capability config database is required');
    if (!accountConfig) throw new Error('pharmacy capability config is required');
    const month = new Date().toISOString().slice(0, 7);
    const count = await input.db.prepare(
      `SELECT COUNT(*) AS count FROM pharmacy_notification_events
        WHERE line_account_id = ? AND category = 'proactive_noncare'
          AND outcome = 'sent' AND substr(occurred_at, 1, 7) = ?`,
    ).bind(input.lineAccountId, month).first<{ count: number }>();
    if ((count?.count ?? 0) >= accountConfig.proactive_monthly_limit) {
      if (input.db) await recordNotificationEvent(input.db, input, 'blocked');
      throw new Error('pharmacy proactive frequency cap reached');
    }
  }

  try {
    await pushViaHarnessProxy(
      input.proxyBaseUrl,
      input.accessToken,
      input.to,
      [message],
      input.retryKey,
      input.proxyDispatch,
    );
    if (input.db && input.lineAccountId) await recordNotificationEvent(input.db, input, 'sent');
  } catch (error) {
    if (input.db && input.lineAccountId) await recordNotificationEvent(input.db, input, 'failed');
    throw error;
  }
}

async function recordNotificationEvent(
  db: D1Database,
  input: { lineAccountId?: string; friendId?: string; messageId: string; category: string; retryKey: string },
  outcome: 'sent' | 'blocked' | 'failed',
): Promise<void> {
  if (!input.lineAccountId) return;
  await db.prepare(
    `INSERT OR IGNORE INTO pharmacy_notification_events
      (id, line_account_id, friend_id, message_id, category, outcome, schema_version, occurred_at, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.lineAccountId, input.friendId ?? null, input.messageId,
    input.category, outcome, new Date().toISOString(), input.retryKey, new Date().toISOString(),
  ).run();
}

export function isApprovedPharmacyMessage(message: Message): boolean {
  return message.type === 'text' && typeof message.text === 'string' && message.text.length <= 500;
}
