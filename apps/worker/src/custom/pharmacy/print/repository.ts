export type PrintJobStatus =
  | 'queued'
  | 'claimed'
  | 'printed'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

export type PrintFailureCode =
  | 'printer_unavailable'
  | 'paper_empty'
  | 'ink_or_toner'
  | 'invalid_document'
  | 'unknown';

export interface PrintJob {
  id: string;
  line_account_id: string;
  submission_id: string;
  file_id: string;
  revision: number;
  status: PrintJobStatus;
  attempt_count: number;
  available_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_until: string | null;
  printed_at: string | null;
  last_failure_code: PrintFailureCode | null;
  created_at: string;
  updated_at: string;
}

export interface PrintEvent {
  id: string;
  job_id: string;
  line_account_id: string;
  event_type:
    | 'enqueued'
    | 'claimed'
    | 'lease_expired'
    | 'printed'
    | 'failed'
    | 'retry_scheduled'
    | 'manual_retry'
    | 'cancelled'
    | 'downloaded';
  actor_type: 'system' | 'staff' | 'agent';
  actor_id: string | null;
  attempt_count: number;
  failure_code: PrintFailureCode | null;
  available_at: string | null;
  created_at: string;
}

export const PRINT_MAX_ATTEMPTS = 3;

const CLAIM_LEASE_MS = 5 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

const JOB_SELECT = `
  SELECT id, line_account_id, submission_id, file_id, revision, status,
         attempt_count, available_at, claimed_by, claimed_at, lease_until,
         printed_at, last_failure_code, created_at, updated_at
    FROM pharmacy_print_jobs`;

const FAILURE_CODES = new Set<PrintFailureCode>([
  'printer_unavailable',
  'paper_empty',
  'ink_or_toner',
  'invalid_document',
  'unknown',
]);

function changed(result: { meta?: { changes?: number } }): boolean {
  return (result.meta?.changes ?? 0) === 1;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
  );
}

function isPrintFailureCode(value: string): value is PrintFailureCode {
  return FAILURE_CODES.has(value as PrintFailureCode);
}

async function getPrintJob(
  db: D1Database,
  lineAccountId: string,
  jobId: string,
): Promise<PrintJob | null> {
  return db.prepare(`${JOB_SELECT} WHERE id = ? AND line_account_id = ?`)
    .bind(jobId, lineAccountId)
    .first<PrintJob>();
}

async function appendPrintEvent(
  db: D1Database,
  input: Omit<PrintEvent, 'id'>,
): Promise<void> {
  await db.prepare(
    `INSERT INTO pharmacy_print_events
       (id, job_id, line_account_id, event_type, actor_type, actor_id,
        attempt_count, failure_code, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    input.job_id,
    input.line_account_id,
    input.event_type,
    input.actor_type,
    input.actor_id,
    input.attempt_count,
    input.failure_code,
    input.available_at,
    input.created_at,
  ).run();
}

export async function assertPharmacyStaffInAccount(
  db: D1Database,
  staffId: string,
  lineAccountId: string,
): Promise<boolean> {
  // The configured env owner is already the account operator. Other staff
  // identities must be present in the account-scoped staff table.
  if (staffId === 'env-owner') return true;
  const row = await db.prepare(
    `SELECT 1 AS ok FROM staff
      WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL
        AND is_active = 1`,
  ).bind(staffId, lineAccountId).first<{ ok: number }>();
  return Boolean(row?.ok);
}

export async function listPharmacyPrintJobs(
  db: D1Database,
  lineAccountId: string,
  status: PrintJobStatus | null = 'queued',
  limit = 50,
): Promise<PrintJob[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const filter = status ? ' AND status = ?' : '';
  const bindings = status
    ? [lineAccountId, status, boundedLimit]
    : [lineAccountId, boundedLimit];
  const result = await db.prepare(
    `${JOB_SELECT}
      WHERE line_account_id = ?${filter}
      ORDER BY created_at, id
      LIMIT ?`,
  ).bind(...bindings).all<PrintJob>();
  return result.results ?? [];
}

/**
 * Enqueue every ready file in the active revision exactly once.
 * The print queue intentionally stores no R2 key or patient data.
 */
export async function enqueuePrescriptionPrintJobs(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
): Promise<number> {
  const submission = await db.prepare(
    `SELECT id, COALESCE(active_revision, upload_revision) AS active_revision
       FROM pharmacy_prescription_submissions
      WHERE id = ? AND line_account_id = ?
        AND status IN ('received','accepted','ready')`,
  ).bind(submissionId, lineAccountId).first<{
    id: string;
    active_revision: number | null;
  }>();
  if (!submission?.active_revision) return 0;

  const files = await db.prepare(
    `SELECT id, revision
       FROM pharmacy_prescription_files
      WHERE submission_id = ? AND revision = ? AND state = 'ready'
      ORDER BY position, id`,
  ).bind(submissionId, submission.active_revision).all<{
    id: string;
    revision: number;
  }>();

  const now = new Date().toISOString();

  // A resubmission must not leave old, not-yet-printed revisions in the queue.
  // Already claimed/printed work is retained for auditability.
  const superseded = await db.prepare(
    `SELECT id, attempt_count
       FROM pharmacy_print_jobs
      WHERE line_account_id = ? AND submission_id = ? AND revision != ?
        AND status IN ('queued', 'failed')`,
  ).bind(lineAccountId, submissionId, submission.active_revision).all<{
    id: string;
    attempt_count: number;
  }>();
  for (const job of superseded.results ?? []) {
    const cancelled = await db.prepare(
      `UPDATE pharmacy_print_jobs
          SET status = 'cancelled', lease_until = NULL, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status IN ('queued', 'failed')`,
    ).bind(now, job.id, lineAccountId).run();
    if (!changed(cancelled)) continue;
    await appendPrintEvent(db, {
      job_id: job.id,
      line_account_id: lineAccountId,
      event_type: 'cancelled',
      actor_type: 'system',
      actor_id: null,
      attempt_count: job.attempt_count,
      failure_code: null,
      available_at: null,
      created_at: now,
    });
  }

  let inserted = 0;
  for (const file of files.results ?? []) {
    const idempotencyKey = `prescription:${submissionId}:${file.revision}:${file.id}`;
    const jobId = crypto.randomUUID();
    const result = await db.prepare(
      `INSERT INTO pharmacy_print_jobs
         (id, line_account_id, submission_id, file_id, revision, idempotency_key,
          status, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT (line_account_id, submission_id, file_id, revision) DO NOTHING`,
    ).bind(
      jobId,
      lineAccountId,
      submissionId,
      file.id,
      file.revision,
      idempotencyKey,
      now,
      now,
      now,
    ).run();
    if (!changed(result)) continue;
    inserted++;
    await appendPrintEvent(db, {
      job_id: jobId,
      line_account_id: lineAccountId,
      event_type: 'enqueued',
      actor_type: 'system',
      actor_id: null,
      attempt_count: 0,
      failure_code: null,
      available_at: now,
      created_at: now,
    });
  }
  return inserted;
}

export async function claimPharmacyPrintJob(
  db: D1Database,
  lineAccountId: string,
  jobId: string,
  staffId: string,
  now = new Date(),
): Promise<PrintJob | null> {
  const timestamp = now.toISOString();
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const before = await getPrintJob(db, lineAccountId, jobId);
  if (!before) return null;

  if (
    before.status === 'claimed' &&
    before.lease_until &&
    Date.parse(before.lease_until) <= now.getTime() &&
    before.attempt_count >= PRINT_MAX_ATTEMPTS
  ) {
    const dead = await db.prepare(
      `UPDATE pharmacy_print_jobs
          SET status = 'dead_letter', lease_until = NULL, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = 'claimed'
          AND lease_until <= ? AND attempt_count >= ?`,
    ).bind(timestamp, jobId, lineAccountId, timestamp, PRINT_MAX_ATTEMPTS).run();
    if (changed(dead)) {
      await appendPrintEvent(db, {
        job_id: jobId,
        line_account_id: lineAccountId,
        event_type: 'lease_expired',
        actor_type: 'system',
        actor_id: null,
        attempt_count: before.attempt_count,
        failure_code: 'unknown',
        available_at: null,
        created_at: timestamp,
      });
    }
    return null;
  }

  const result = await db.prepare(
    `UPDATE pharmacy_print_jobs
        SET status = 'claimed', claimed_by = ?, claimed_at = ?, lease_until = ?,
            attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND attempt_count < ?
        AND ((status IN ('queued','failed') AND available_at <= ?)
          OR (status = 'claimed' AND lease_until <= ?))`,
  ).bind(
    staffId,
    timestamp,
    leaseUntil,
    timestamp,
    jobId,
    lineAccountId,
    PRINT_MAX_ATTEMPTS,
    timestamp,
    timestamp,
  ).run();
  if (!changed(result)) return null;

  const job = await getPrintJob(db, lineAccountId, jobId);
  if (!job) return null;
  if (before.status === 'claimed') {
    await appendPrintEvent(db, {
      job_id: jobId,
      line_account_id: lineAccountId,
      event_type: 'lease_expired',
      actor_type: 'system',
      actor_id: null,
      attempt_count: before.attempt_count,
      failure_code: null,
      available_at: null,
      created_at: timestamp,
    });
  }
  await appendPrintEvent(db, {
    job_id: jobId,
    line_account_id: lineAccountId,
    event_type: 'claimed',
    actor_type: 'staff',
    actor_id: staffId,
    attempt_count: job.attempt_count,
    failure_code: null,
    available_at: job.available_at,
    created_at: timestamp,
  });
  return job;
}

export async function markPharmacyPrintJobPrinted(
  db: D1Database,
  lineAccountId: string,
  jobId: string,
  staffId: string,
  now = new Date(),
): Promise<PrintJob | null> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_print_jobs
        SET status = 'printed', printed_at = ?, lease_until = NULL, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'claimed' AND claimed_by = ?`,
  ).bind(timestamp, timestamp, jobId, lineAccountId, staffId).run();
  if (!changed(result)) return null;
  const job = await getPrintJob(db, lineAccountId, jobId);
  if (!job) return null;
  await appendPrintEvent(db, {
    job_id: jobId,
    line_account_id: lineAccountId,
    event_type: 'printed',
    actor_type: 'staff',
    actor_id: staffId,
    attempt_count: job.attempt_count,
    failure_code: null,
    available_at: null,
    created_at: timestamp,
  });
  return job;
}

export async function markPharmacyPrintJobFailed(
  db: D1Database,
  lineAccountId: string,
  jobId: string,
  staffId: string,
  failureCode: PrintFailureCode,
  now = new Date(),
): Promise<PrintJob | null> {
  if (!isPrintFailureCode(failureCode)) throw new Error('invalid print failure code');
  const timestamp = now.toISOString();
  const before = await getPrintJob(db, lineAccountId, jobId);
  if (
    !before ||
    before.status !== 'claimed' ||
    before.claimed_by !== staffId
  ) return null;

  const retryAt = new Date(now.getTime() + retryDelayMs(before.attempt_count)).toISOString();
  const nextStatus: PrintJobStatus = before.attempt_count >= PRINT_MAX_ATTEMPTS
    ? 'dead_letter'
    : 'failed';
  const result = await db.prepare(
    `UPDATE pharmacy_print_jobs
        SET status = ?, last_failure_code = ?, lease_until = NULL,
            available_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'claimed' AND claimed_by = ?`,
  ).bind(
    nextStatus,
    failureCode,
    retryAt,
    timestamp,
    jobId,
    lineAccountId,
    staffId,
  ).run();
  if (!changed(result)) return null;
  const job = await getPrintJob(db, lineAccountId, jobId);
  if (!job) return null;
  await appendPrintEvent(db, {
    job_id: jobId,
    line_account_id: lineAccountId,
    event_type: 'failed',
    actor_type: 'staff',
    actor_id: staffId,
    attempt_count: job.attempt_count,
    failure_code: failureCode,
    available_at: retryAt,
    created_at: timestamp,
  });
  if (nextStatus === 'failed') {
    await appendPrintEvent(db, {
      job_id: jobId,
      line_account_id: lineAccountId,
      event_type: 'retry_scheduled',
      actor_type: 'system',
      actor_id: null,
      attempt_count: job.attempt_count,
      failure_code: failureCode,
      available_at: retryAt,
      created_at: timestamp,
    });
  }
  return job;
}

export async function retryPharmacyPrintJob(
  db: D1Database,
  lineAccountId: string,
  jobId: string,
  staffId: string,
  now = new Date(),
): Promise<PrintJob | null> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE pharmacy_print_jobs
        SET status = 'queued', attempt_count = 0, available_at = ?,
            claimed_by = NULL, claimed_at = NULL, lease_until = NULL,
            printed_at = NULL, last_failure_code = NULL, updated_at = ?
      WHERE id = ? AND line_account_id = ?
        AND status IN ('failed','dead_letter','cancelled')`,
  ).bind(timestamp, timestamp, jobId, lineAccountId).run();
  if (!changed(result)) return null;
  const job = await getPrintJob(db, lineAccountId, jobId);
  if (!job) return null;
  await appendPrintEvent(db, {
    job_id: jobId,
    line_account_id: lineAccountId,
    event_type: 'manual_retry',
    actor_type: 'staff',
    actor_id: staffId,
    attempt_count: job.attempt_count,
    failure_code: null,
    available_at: timestamp,
    created_at: timestamp,
  });
  return job;
}

export async function listPharmacyPrintEvents(
  db: D1Database,
  lineAccountId: string,
  jobId: string,
): Promise<PrintEvent[]> {
  const result = await db.prepare(
    `SELECT e.id, e.job_id, e.line_account_id, e.event_type,
            e.actor_type, e.actor_id, e.attempt_count, e.failure_code,
            e.available_at, e.created_at
       FROM pharmacy_print_events e
      WHERE e.line_account_id = ? AND e.job_id = ?
      ORDER BY e.created_at, e.id`,
  ).bind(lineAccountId, jobId).all<PrintEvent>();
  return result.results ?? [];
}
