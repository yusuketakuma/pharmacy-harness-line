import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { sendPharmacyAutomatedPush } from '../growth-loop/sender.js';
import {
  listDueMedicationFollowUps,
  transitionMedicationFollowUp,
} from './repository.js';

export async function processDueMedicationFollowUps(
  db: D1Database,
  options: {
    proxyBaseUrl: string;
    proxyDispatch?: HarnessProxyDispatch;
    now?: Date;
    limit?: number;
  },
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const rows = await listDueMedicationFollowUps(db, now, options.limit);
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    let current = row;
    try {
      if (current.status === 'scheduled') {
        current = { ...current, ...await transitionMedicationFollowUp(db, {
          lineAccountId: current.line_account_id,
          followUpId: current.id,
          toStatus: 'due',
          expectedVersion: current.version,
          actorType: 'system',
          actorId: 'medication-followup-cron',
          now,
        }) };
      }
    } catch {
      result.skipped++;
      continue;
    }
    if (!current.line_user_id || !current.channel_access_token) {
      result.skipped++;
      continue;
    }
    try {
      const outcome = await sendPharmacyAutomatedPush({
        db,
        proxyBaseUrl: options.proxyBaseUrl,
        proxyDispatch: options.proxyDispatch,
        accessToken: current.channel_access_token,
        to: current.line_user_id,
        lineAccountId: current.line_account_id,
        friendId: current.owner_friend_id,
        messageId: 'medication_followup_v1',
        category: 'followup_care',
        vars: { followUpId: current.id },
        retryKey: `medication-followup:${current.id}`,
        now,
      });
      if (outcome === 'in_progress') {
        result.skipped++;
        continue;
      }
      await transitionMedicationFollowUp(db, {
        lineAccountId: current.line_account_id,
        followUpId: current.id,
        toStatus: 'delivered',
        expectedVersion: current.version,
        actorType: 'system',
        actorId: 'medication-followup-cron',
        now,
      });
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
