import type { HarnessProxyDispatch } from '../../../services/line-proxy-send.js';
import { markPrescriptionValidityExpiredReview } from './repository.js';
import { sendPharmacyAutomatedPush } from './sender.js';
import { readLineCredential } from '../provisioning/line-credential-store.js';

type DueValidity = {
  submission_id: string;
  line_account_id: string;
  tenant_id: string;
  friend_id: string;
  valid_until: string;
  line_user_id: string;
};

export async function processDuePrescriptionValidityReminders(
  db: D1Database,
  options: { proxyBaseUrl: string; proxyDispatch?: HarnessProxyDispatch; lineCredentialKey?: string; now?: Date; limit?: number },
): Promise<{ sent: number; failed: number; skipped: number; expiredReviewRequired: number }> {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const today = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const staleClaim = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
  const expiredRows = await db.prepare(
    `SELECT v.submission_id, v.line_account_id
       FROM pharmacy_prescription_validities v
       INNER JOIN line_accounts la
         ON la.id = v.line_account_id AND la.is_active = 1
       INNER JOIN tenant_line_accounts mapping
         ON mapping.line_account_id = v.line_account_id
       INNER JOIN tenants tenant
         ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
       INNER JOIN pharmacy_account_capabilities capability
         ON capability.line_account_id = v.line_account_id AND capability.mode = 'pharmacy'
      WHERE v.verification_status = 'verified' AND v.valid_until IS NOT NULL AND v.valid_until < ?
        AND EXISTS (
          SELECT 1 FROM pharmacy_prescription_submissions s
           WHERE s.id = v.submission_id AND s.line_account_id = v.line_account_id
             AND s.status NOT IN ('closed','cancelled')
        )
      ORDER BY v.valid_until, v.submission_id LIMIT ?`,
  ).bind(today, limit).all<Pick<DueValidity, 'submission_id' | 'line_account_id'>>();
  let expiredReviewRequired = 0;
  for (const row of expiredRows.results ?? []) {
    if (await markPrescriptionValidityExpiredReview(db, {
      lineAccountId: row.line_account_id,
      submissionId: row.submission_id,
      localDate: today,
      actorId: 'system',
      at: now,
    })) expiredReviewRequired++;
  }
  const rows = await db.prepare(
    `SELECT v.submission_id, v.line_account_id, s.friend_id, v.valid_until,
            f.provider_line_user_id AS line_user_id, mapping.tenant_id AS tenant_id
       FROM pharmacy_prescription_validities v
       INNER JOIN pharmacy_prescription_submissions s
         ON s.id = v.submission_id AND s.line_account_id = v.line_account_id
       INNER JOIN friends f ON f.id = s.friend_id AND f.line_account_id = s.line_account_id
       INNER JOIN line_accounts la ON la.id = s.line_account_id
       INNER JOIN tenant_line_accounts mapping
         ON mapping.line_account_id = s.line_account_id
       INNER JOIN tenants tenant
         ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
       INNER JOIN pharmacy_account_capabilities pc
         ON pc.line_account_id = s.line_account_id AND pc.mode = 'pharmacy'
        AND EXISTS (SELECT 1 FROM json_each(pc.capabilities_json) WHERE json_each.value = 'prescription_intake')
      WHERE v.verification_status = 'verified' AND v.valid_until IS NOT NULL
        AND v.valid_until >= ?
        AND v.reminder_due_at IS NOT NULL AND v.reminder_due_at <= ?
        AND v.reminder_sent_at IS NULL
        AND (v.reminder_claimed_at IS NULL OR v.reminder_claimed_at < ?)
        AND s.status = 'ready'
        AND f.is_following = 1 AND la.is_active = 1
      ORDER BY v.reminder_due_at, v.submission_id LIMIT ?`,
  ).bind(today, timestamp, staleClaim, limit).all<DueValidity>();

  const result = {
    sent: 0,
    failed: 0,
    skipped: 0,
    expiredReviewRequired,
  };
  for (const row of rows.results ?? []) {
    const claim = await db.prepare(
      `UPDATE pharmacy_prescription_validities
          SET reminder_claimed_at = ?, updated_at = ?
        WHERE submission_id = ? AND line_account_id = ?
          AND verification_status = 'verified' AND reminder_sent_at IS NULL
          AND (reminder_claimed_at IS NULL OR reminder_claimed_at < ?)
          AND valid_until IS NOT NULL AND valid_until >= ?
          AND EXISTS (
            SELECT 1 FROM pharmacy_prescription_submissions s
             WHERE s.id = pharmacy_prescription_validities.submission_id
               AND s.line_account_id = pharmacy_prescription_validities.line_account_id
               AND s.status = 'ready'
          )
          AND EXISTS (
            SELECT 1 FROM pharmacy_account_capabilities capability
             WHERE capability.line_account_id = pharmacy_prescription_validities.line_account_id
               AND capability.mode = 'pharmacy'
               AND EXISTS (SELECT 1 FROM json_each(capability.capabilities_json)
                            WHERE value = 'prescription_intake')
          )`,
    ).bind(timestamp, timestamp, row.submission_id, row.line_account_id, staleClaim, today).run();
    if ((claim.meta?.changes ?? 0) !== 1) {
      result.skipped++;
      continue;
    }
    // Hands the claim back so the reminder is due again on the next sweep.
    const releaseClaim = () => db.prepare(
      `UPDATE pharmacy_prescription_validities
          SET reminder_claimed_at = NULL, updated_at = ?
        WHERE submission_id = ? AND line_account_id = ? AND reminder_claimed_at = ?`,
    ).bind(timestamp, row.submission_id, row.line_account_id, timestamp).run();

    const accessToken = options.lineCredentialKey
      ? await readLineCredential(db, options.lineCredentialKey, {
        tenantId: row.tenant_id,
        lineAccountId: row.line_account_id,
        kind: 'channel_access_token',
      }).catch(() => null)
      : null;
    if (!accessToken) {
      await releaseClaim();
      result.skipped++;
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
        messageId: 'prescription_validity_reminder_v1',
        category: 'transactional_care',
        vars: { genericDate: row.valid_until },
        retryKey: `prescription-validity:${row.submission_id}:${row.valid_until}`,
      });
      // Never stamp reminder_sent_at for a paused tenant — nothing was sent.
      if (outcome === 'paused') {
        await releaseClaim();
        result.skipped++;
        continue;
      }
      await db.prepare(
        `UPDATE pharmacy_prescription_validities
            SET reminder_sent_at = ?, reminder_claimed_at = NULL, updated_at = ?
          WHERE submission_id = ? AND line_account_id = ? AND reminder_claimed_at = ?`,
      ).bind(timestamp, timestamp, row.submission_id, row.line_account_id, timestamp).run();
      result.sent++;
    } catch {
      await releaseClaim();
      result.failed++;
    }
  }
  return result;
}
