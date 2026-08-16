export interface PrescriptionCleanupOptions {
  now?: Date;
  limit?: number;
}

interface CleanupCandidate {
  file_id: string;
  submission_id: string;
  r2_key: string;
  revision: number;
  state: 'pending' | 'ready' | 'deleted';
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function cleanupPrescriptionImages(
  db: D1Database,
  images: R2Bucket,
  options: PrescriptionCleanupOptions = {},
): Promise<{ claimed: number; deleted: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const draftCutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const terminalCutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
  const due = await db.prepare(
    `SELECT f.id AS file_id, f.submission_id, f.r2_key, f.revision, f.state
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
      WHERE NOT (
              s.status IN ('received','needs_resubmission','accepted','ready')
              AND f.revision = s.active_revision
            )
        AND (
          (f.state = 'deleted' AND NOT EXISTS (
            SELECT 1 FROM pharmacy_prescription_events deleted_event
             WHERE deleted_event.submission_id = f.submission_id
               AND deleted_event.event_type = 'file_deleted'
               AND deleted_event.actor_id = f.id
          ))
          OR
          (f.state != 'deleted' AND (
            EXISTS (
              SELECT 1 FROM pharmacy_prescription_events patient_cancel
               WHERE patient_cancel.submission_id = s.id
                 AND patient_cancel.event_type = 'status_changed'
                 AND patient_cancel.to_status = 'cancelled'
                 AND patient_cancel.reason_code = 'patient_cancelled'
            )
            OR (
              s.status = 'draft' AND s.updated_at <= ? AND f.updated_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM pharmacy_prescription_files recent_file
                 WHERE recent_file.submission_id = s.id
                   AND recent_file.updated_at > ?
              )
            )
            OR (
              s.closed_at <= ? AND (
                s.status = 'closed'
                OR (s.status = 'cancelled' AND EXISTS (
                  SELECT 1 FROM pharmacy_prescription_events admin_cancel
                   WHERE admin_cancel.submission_id = s.id
                     AND admin_cancel.event_type = 'status_changed'
                     AND admin_cancel.to_status = 'cancelled'
                     AND admin_cancel.reason_code = 'admin_cancelled'
                ))
              )
            )
          ))
        )
      ORDER BY CASE WHEN f.state = 'deleted' THEN 0 ELSE 1 END,
               COALESCE(s.closed_at, s.updated_at), f.id
      LIMIT ?`,
  ).bind(draftCutoff, draftCutoff, draftCutoff, terminalCutoff, limit)
    .all<CleanupCandidate>();

  const result = { claimed: 0, deleted: 0, failed: 0, skipped: 0 };
  for (const file of due.results ?? []) {
    if (file.state !== 'deleted') {
      const claim = await db.prepare(
        `UPDATE pharmacy_prescription_files AS f
            SET state = 'deleted', updated_at = ?
          WHERE f.id = ? AND f.state != 'deleted'
            AND EXISTS (
              SELECT 1 FROM pharmacy_prescription_submissions s
               WHERE s.id = f.submission_id
                 AND NOT (
                   s.status IN ('received','needs_resubmission','accepted','ready')
                   AND f.revision = s.active_revision
                 )
                 AND (
                   EXISTS (
                     SELECT 1 FROM pharmacy_prescription_events patient_cancel
                      WHERE patient_cancel.submission_id = s.id
                        AND patient_cancel.event_type = 'status_changed'
                        AND patient_cancel.to_status = 'cancelled'
                        AND patient_cancel.reason_code = 'patient_cancelled'
                   )
                   OR (
                     s.status = 'draft' AND s.updated_at <= ? AND f.updated_at <= ?
                     AND NOT EXISTS (
                       SELECT 1 FROM pharmacy_prescription_files recent_file
                        WHERE recent_file.submission_id = s.id
                          AND recent_file.updated_at > ?
                     )
                   )
                   OR (
                     s.closed_at <= ? AND (
                       s.status = 'closed'
                       OR (s.status = 'cancelled' AND EXISTS (
                         SELECT 1 FROM pharmacy_prescription_events admin_cancel
                          WHERE admin_cancel.submission_id = s.id
                            AND admin_cancel.event_type = 'status_changed'
                            AND admin_cancel.to_status = 'cancelled'
                            AND admin_cancel.reason_code = 'admin_cancelled'
                       ))
                     )
                   )
                 )
            )`,
      ).bind(
        nowIso, file.file_id, draftCutoff, draftCutoff, draftCutoff, terminalCutoff,
      ).run();
      if ((claim.meta?.changes ?? 0) !== 1) {
        result.skipped++;
        continue;
      }
      result.claimed++;
    }

    try {
      await images.delete(file.r2_key);
    } catch {
      result.failed++;
      continue;
    }

    await db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type, revision, created_at)
       SELECT ?, f.submission_id, 'system', f.id, 'file_deleted', f.revision, ?
         FROM pharmacy_prescription_files f
        WHERE f.id = ? AND f.submission_id = ? AND f.state = 'deleted'
          AND NOT EXISTS (
            SELECT 1 FROM pharmacy_prescription_events existing
             WHERE existing.submission_id = f.submission_id
               AND existing.event_type = 'file_deleted'
               AND existing.actor_id = f.id
          )`,
    ).bind(
      crypto.randomUUID(), nowIso, file.file_id, file.submission_id,
    ).run();
    result.deleted++;
  }
  return result;
}
