import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';
import {
  markNextIntakeExpectationReminded,
  type DueNextIntakeExpectation,
} from './next-intake.js';

export interface ContinuityNotificationOptions {
  db: D1Database;
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
}

export function continuityReminderText(): string {
  return '次回のお薬の相談時期が近づいています。必要な処方せんがあれば、薬局へ事前送信できます。';
}

export async function deliverContinuityReminder(
  reminder: DueNextIntakeExpectation,
  options: ContinuityNotificationOptions,
): Promise<'sent' | 'failed' | 'skipped'> {
  if (!reminder.line_user_id || !reminder.channel_access_token) return 'skipped';
  try {
    const outcome = await sendPharmacyAutomatedPush({
      db: options.db,
      proxyBaseUrl: options.proxyBaseUrl,
      proxyDispatch: options.proxyDispatch,
      accessToken: reminder.channel_access_token,
      to: reminder.line_user_id,
      lineAccountId: reminder.line_account_id,
      friendId: reminder.owner_friend_id,
      messageId: 'continuity_reminder_v1',
      category: 'continuity',
      retryKey: `next-intake:${reminder.id}`,
    });
    if (outcome === 'in_progress') return 'skipped';
    await markNextIntakeExpectationReminded(options.db, {
      lineAccountId: reminder.line_account_id,
      expectationId: reminder.id,
      expectedVersion: reminder.version,
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}
