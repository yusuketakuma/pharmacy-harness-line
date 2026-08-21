// H-5. Statutory retention backstop for prescription image objects.
//
// Business decision (2026-08-19): all PHI is kept for exactly 3 years, applying
// the 薬剤師法施行規則 retention duty for 調剤録/調剤済み処方箋 uniformly to every
// PHI-bearing store. Matrix: docs/pharmacy/RETENTION_MATRIX.md.
//
// This is deliberately NOT part of cleanupPrescriptionImages. That job reaps
// images whose *workflow* is over (cancelled, abandoned draft, closed 30 days
// ago) and by design never touches the active revision of a live submission.
// This one is the *legal* backstop: past three years, the image goes regardless
// of submission status, and it re-runs against rows the workflow cleanup marked
// deleted but failed to actually remove from R2.
//
// Fail-closed: a row is purged only when its age reference is present and
// unambiguously older than the boundary. Anything unparseable is kept.

export interface PrescriptionRetentionPurgeOptions {
  now?: Date;
  /** Overridable only so tests do not have to fabricate three-year-old rows. */
  retentionYears?: number;
  limit?: number;
}

interface PurgeCandidate {
  file_id: string;
  r2_key: string;
  created_at: string;
  tenant_id: string | null;
  line_account_id: string;
}

const RETENTION_YEARS = 3;
const PURGE_BATCH_LIMIT = 50;

/**
 * Every runtime write of `pharmacy_prescription_files.created_at` is
 * `new Date().toISOString()`, so a purgeable value is UTC and ends in `Z`.
 * Restricting the comparison to that exact shape is what makes the cutoff
 * comparison safe: a JST-offset or date-only string would sort against a `Z`
 * cutoff by accident, and an empty or malformed one would sort before every
 * cutoff and be deleted. Those are kept instead — a missed purge is
 * recoverable, a wrong delete is not.
 */
const UTC_TIMESTAMP_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';

/** Calendar-correct so leap days do not shift the boundary. */
function retentionCutoff(now: Date, years: number): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff.toISOString();
}

export async function purgePrescriptionFilesPastRetention(
  db: D1Database,
  images: R2Bucket,
  options: PrescriptionRetentionPurgeOptions = {},
): Promise<{ purged: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const retentionYears = options.retentionYears ?? RETENTION_YEARS;
  const cutoff = retentionCutoff(now, retentionYears);
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? PURGE_BATCH_LIMIT)));

  // The purge-log row is the completion marker, so a run interrupted between
  // the R2 delete and the log write simply retries (R2 delete is idempotent).
  // A file's patient is only known once intake review links a
  // pharmacy_prescription_patients row; a file with no such row has no legal
  // hold to check (the LEFT JOIN leaves patient.patient_id NULL, and the
  // NOT EXISTS below is vacuously true for a NULL comparison).
  const heldClause = `
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_data_subject_requests hold
           WHERE hold.patient_id = patient.patient_id
             AND hold.line_account_id = patient.line_account_id
             AND hold.owner_friend_id = patient.owner_friend_id
             AND hold.legal_hold = 1
             AND (hold.legal_hold_release_at IS NULL OR hold.legal_hold_release_at > ?)
        )`;
  const dueQueryBase = `
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
       LEFT JOIN tenant_line_accounts mapping ON mapping.line_account_id = s.line_account_id
       LEFT JOIN pharmacy_prescription_patients patient ON patient.submission_id = f.submission_id
      WHERE f.created_at GLOB ?
        AND f.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_phi_retention_purge_log purged
           WHERE purged.resource_type = 'prescription_file'
             AND purged.resource_id = f.id
        )`;

  const due = await db.prepare(
    `SELECT f.id AS file_id, f.r2_key, f.created_at,
            mapping.tenant_id AS tenant_id, s.line_account_id
       ${dueQueryBase}${heldClause}
      ORDER BY f.created_at, f.id
      LIMIT ?`,
  ).bind(UTC_TIMESTAMP_GLOB, cutoff, nowIso, limit).all<PurgeCandidate>();

  const heldCount = await db.prepare(
    `SELECT COUNT(*) AS n
       ${dueQueryBase}
        AND EXISTS (
          SELECT 1 FROM pharmacy_data_subject_requests hold
           WHERE hold.patient_id = patient.patient_id
             AND hold.line_account_id = patient.line_account_id
             AND hold.owner_friend_id = patient.owner_friend_id
             AND hold.legal_hold = 1
             AND (hold.legal_hold_release_at IS NULL OR hold.legal_hold_release_at > ?)
        )`,
  ).bind(UTC_TIMESTAMP_GLOB, cutoff, nowIso).first<{ n: number }>();

  const result = { purged: 0, failed: 0, skipped: heldCount?.n ?? 0 };
  for (const file of due.results ?? []) {
    try {
      await images.delete(file.r2_key);
    } catch {
      // Keep the row unmarked and unlogged so the next tick retries it.
      result.failed++;
      continue;
    }

    await db.prepare(
      `UPDATE pharmacy_prescription_files
          SET state = 'deleted', updated_at = ?
        WHERE id = ? AND state != 'deleted'`,
    ).bind(nowIso, file.file_id).run();

    // Written last and separately from the row it describes: the evidence that
    // a specific object was removed by the retention rule has to survive the
    // eventual deletion of the prescription record itself.
    await db.prepare(
      `INSERT OR IGNORE INTO pharmacy_phi_retention_purge_log
         (id, tenant_id, line_account_id, resource_type, resource_id, r2_key,
          age_reference_at, retention_years, purged_at)
       VALUES (?, ?, ?, 'prescription_file', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      file.tenant_id,
      file.line_account_id,
      file.file_id,
      file.r2_key,
      file.created_at,
      retentionYears,
      nowIso,
    ).run();
    result.purged++;
  }
  return result;
}
