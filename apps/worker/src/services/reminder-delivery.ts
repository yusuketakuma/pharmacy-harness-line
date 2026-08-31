import { extractFlexAltText } from '../utils/flex-alt-text.js';

/**
 * リマインダ配信処理 — cronトリガーで定期実行
 *
 * target_date + offset_minutes の時刻が現在時刻以前で
 * まだ配信されていないステップを配信する
 */

import {
  getDueReminderDeliveries,
  completeReminderIfDone,
  getFriendById,
  jstNow,
} from '@line-crm/db';
import type { LineClient, Message } from '@line-crm/line-sdk';
import { addJitter, sleep } from './stealth.js';
import { isPharmacyModeAccount } from '../custom/pharmacy/growth-loop/access.js';
import { createBroadcastRetryKey } from './broadcast-retry-key.js';
import { deliverTrackedLinePush } from './outbound-line-delivery.js';
import { getActiveMappedAccountTenantId } from './step-delivery.js';

export async function processReminderDeliveries(
  db: D1Database,
  _lineClient: LineClient,
): Promise<void> {
  const now = jstNow();
  const dueReminders = await getDueReminderDeliveries(db, now);

  for (let i = 0; i < dueReminders.length; i++) {
    const fr = dueReminders[i];
    try {
      // ステルス: バースト回避のためランダム遅延
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }

      const friend = await getFriendById(db, fr.friend_id);
      if (!friend || !friend.is_following) {
        continue;
      }

      if (await isPharmacyModeAccount(db, friend.line_account_id)) continue;
      const friendAccountId = (friend as unknown as Record<string, string | null>).line_account_id;
      const tenantId = await getActiveMappedAccountTenantId(db, friendAccountId);
      if (!tenantId || !friendAccountId) continue;

      // Resolve correct lineClient for this friend's account
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, friendAccountId);
      if (!account) continue;
      const { LineClient: LC } = await import('@line-crm/line-sdk');
      const deliveryClient = new LC(account.channel_access_token);

      for (const step of fr.steps) {
        const message = buildMessage(step.message_type, step.message_content);
        const retryKey = await createBroadcastRetryKey('reminder', fr.id, step.id);
        const result = await deliverTrackedLinePush({
          db,
          operationId: retryKey,
          tenantId,
          lineAccountId: friendAccountId,
          friendId: friend.id,
          messageType: step.message_type,
          content: step.message_content,
          source: 'reminder',
          request: { to: friend.line_user_id, messages: [message] },
          send: async (request, providerRetryKey) => {
            await deliveryClient.pushMessage(
              request.to,
              request.messages,
              providerRetryKey,
            );
          },
        });
        if (result !== 'sent' && result !== 'already_sent') {
          throw new Error('OUTBOUND_LINE_RECONCILIATION_REQUIRED');
        }

        // Mark as delivered AFTER successful send.
        // INSERT OR IGNORE prevents duplicate records if parallel workers both sent.
        // Prefer possible duplicate send over silent message loss on crash.
        const lockId = crypto.randomUUID();
        await db
          .prepare(`INSERT OR IGNORE INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id) VALUES (?, ?, ?)`)
          .bind(lockId, fr.id, step.id)
          .run();

      }

      // 全ステップ配信済みかチェック
      await completeReminderIfDone(db, fr.id, fr.reminder_id);
    } catch (err) {
      console.error('リマインダ配信エラー:', err);
    }
  }
}

function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }
  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(messageContent) as { originalContentUrl: string; previewImageUrl: string };
      return { type: 'image', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }
  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      return { type: 'flex', altText: altText || extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }
  return { type: 'text', text: messageContent };
}
