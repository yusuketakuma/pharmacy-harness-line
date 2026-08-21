// NEXT-2. Enforces pharmacy_emergency_settings.retention_days (1-365, custom_035),
// the per-account promise shown to the patient at consent time
// (EmergencyContraceptionPage.tsx "保存期間 N日間"). Nothing purged this before.
//
// Fail-closed rules, mirroring prescriptions/retention-purge.ts (H-5):
//   - An intake is purgeable only when created_at matches the UTC-`Z` shape the
//     runtime actually writes. Anything else is unparseable and is kept, not
//     guessed at — counted separately as skippedFormat.
//   - A patient under an active pharmacy_data_subject_requests legal hold
//     (custom_038) is never purged; counted separately as skippedLegalHold.
//     EC intakes carry no patient_id (PHI-minimal by design, custom_035), so the
//     hold is matched on (line_account_id, owner_friend_id) — the same pair a
//     data-subject request row itself carries as real columns, not a derived join.
//
// What "purge" means here deliberately differs from the prescriptions job:
// pharmacy_emergency_intake_events has an unconditional BEFORE DELETE trigger
// (pharmacy_emergency_events_no_delete, custom_035) that aborts every delete,
// including ones a FOREIGN KEY ... ON DELETE CASCADE issues on its behalf —
// SQLite fires child BEFORE DELETE triggers for FK-cascaded deletes regardless
// of the recursive_triggers pragma. That makes physically deleting the intake
// row (or its events) impossible without weakening an existing immutable-audit
// invariant that other tables in this schema rely on the same way. Instead this
// job redacts the intake's PHI content in place — encrypted_payload and
// risk_flags_json, the two columns that actually hold the patient's answers —
// and leaves the row (and its immutable event trail) present. That satisfies
// the retention promise (the substance of what the patient told the pharmacy
// is gone after N days) without touching a trigger that guards a legal/audit
// trail. age_band and safe_contact_mode are left as-is: both are coarse,
// non-freeform values already stripped of identifying detail once the payload
// is gone, and age_band's CHECK constraint has no "redacted" member to move to.

import { UTC_TIMESTAMP_GLOB } from '../prescriptions/retention-purge.js';

export interface EmergencyRetentionPurgeOptions {
  now?: Date;
  /** Per-account cap, same idea as the prescriptions job's `limit`. */
  limit?: number;
}

interface AccountRetentionSetting {
  line_account_id: string;
  retention_days: number;
}

interface PurgeCandidateRow {
  id: string;
  created_at: string;
  on_legal_hold: number;
}

const PURGE_BATCH_LIMIT = 100;

/** Calendar-correct so leap days do not shift the boundary. */
function retentionCutoff(now: Date, days: number): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString();
}

export async function purgeEmergencyIntakesPastRetention(
  db: D1Database,
  options: EmergencyRetentionPurgeOptions = {},
): Promise<{
  purged: number;
  failed: number;
  skippedFormat: number;
  skippedLegalHold: number;
}> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? PURGE_BATCH_LIMIT)));

  const accounts = await db.prepare(
    `SELECT line_account_id, retention_days FROM pharmacy_emergency_settings`,
  ).all<AccountRetentionSetting>();

  const result = { purged: 0, failed: 0, skippedFormat: 0, skippedLegalHold: 0 };

  // One account's failure (bad data, a lock, anything) must not stop the rest —
  // each account gets its own try/catch and its own db.batch(), never mixed.
  for (const account of accounts.results ?? []) {
    try {
      const cutoff = retentionCutoff(now, account.retention_days);

      const formatSkipped = await db.prepare(
        `SELECT COUNT(*) AS n
           FROM pharmacy_emergency_intakes intake
          WHERE intake.line_account_id = ?
            AND intake.created_at NOT GLOB ?
            AND NOT EXISTS (
              SELECT 1 FROM pharmacy_emergency_retention_purge_log purged
               WHERE purged.resource_type = 'emergency_intake'
                 AND purged.resource_id = intake.id
            )`,
      ).bind(account.line_account_id, UTC_TIMESTAMP_GLOB).first<{ n: number }>();
      result.skippedFormat += formatSkipped?.n ?? 0;

      const due = await db.prepare(
        `SELECT intake.id AS id, intake.created_at AS created_at,
                EXISTS (
                  SELECT 1 FROM pharmacy_data_subject_requests dsr
                   WHERE dsr.line_account_id = intake.line_account_id
                     AND dsr.owner_friend_id = intake.owner_friend_id
                     AND dsr.legal_hold = 1
                     AND (dsr.legal_hold_release_at IS NULL OR dsr.legal_hold_release_at > ?)
                ) AS on_legal_hold
           FROM pharmacy_emergency_intakes intake
          WHERE intake.line_account_id = ?
            AND intake.created_at GLOB ?
            AND intake.created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM pharmacy_emergency_retention_purge_log purged
               WHERE purged.resource_type = 'emergency_intake'
                 AND purged.resource_id = intake.id
            )
          ORDER BY intake.created_at, intake.id
          LIMIT ?`,
      ).bind(nowIso, account.line_account_id, UTC_TIMESTAMP_GLOB, cutoff, limit)
        .all<PurgeCandidateRow>();

      const rows = due.results ?? [];
      const toPurge = rows.filter((row) => !row.on_legal_hold);
      result.skippedLegalHold += rows.length - toPurge.length;
      if (toPurge.length === 0) continue;

      const statements = toPurge.flatMap((row) => [
        db.prepare(
          `UPDATE pharmacy_emergency_intakes
              SET encrypted_payload = '', risk_flags_json = '[]', updated_at = ?
            WHERE id = ? AND line_account_id = ?`,
        ).bind(nowIso, row.id, account.line_account_id),
        // Written last: the evidence that a specific intake's PHI was cleared by
        // the retention rule has to survive whatever eventually happens to the
        // intake row it describes, and its presence is what makes this idempotent.
        db.prepare(
          `INSERT OR IGNORE INTO pharmacy_emergency_retention_purge_log
             (id, line_account_id, resource_type, resource_id, age_reference_at,
              retention_days, purged_at)
           VALUES (?, ?, 'emergency_intake', ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), account.line_account_id, row.id, row.created_at,
          account.retention_days, nowIso,
        ),
      ]);
      await db.batch(statements);
      result.purged += toPurge.length;
    } catch {
      // Deliberately no error content logged here (may echo bound values on
      // some drivers) — the caller logs only this function's numeric counts.
      result.failed += 1;
    }
  }
  return result;
}
