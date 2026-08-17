import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { pushViaHarnessProxy } from '../../../services/line-proxy-send.js';
import type { DueContinuityReminder } from './repository.js';

export interface ContinuityNotificationOptions {
  proxyBaseUrl: string;
  proxyDispatch?: HarnessProxyDispatch;
}

export function continuityReminderText(): string {
  return '次回のお薬の相談時期が近づいています。必要な処方せんがあれば、薬局へ事前送信できます。';
}

export async function deliverContinuityReminder(
  reminder: DueContinuityReminder,
  options: ContinuityNotificationOptions,
): Promise<'sent' | 'failed' | 'skipped'> {
  if (!reminder.line_user_id || !reminder.channel_access_token) return 'skipped';
  try {
    await pushViaHarnessProxy(
      options.proxyBaseUrl,
      reminder.channel_access_token,
      reminder.line_user_id,
      [{ type: 'text', text: continuityReminderText() }],
      `continuity:${reminder.id}:${reminder.reminder_count}`,
      options.proxyDispatch,
    );
    return 'sent';
  } catch {
    return 'failed';
  }
}
