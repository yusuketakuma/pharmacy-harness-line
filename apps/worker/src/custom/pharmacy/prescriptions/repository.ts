import type { PrescriptionPatient } from './patient.js';
import {
  nextPrescriptionStatus,
  type PrescriptionAction,
  type PrescriptionStatus,
} from './state.js';

function nextIsoTimestamp(expectedUpdatedAt: string): string {
  const now = Date.now();
  const expected = Date.parse(expectedUpdatedAt);
  return new Date(Number.isFinite(expected) && now <= expected ? expected + 1 : now).toISOString();
}

export interface PrescriptionDraft {
  id: string;
  status: string;
  upload_revision: number;
  updated_at: string;
}

export interface ReserveDraftInput {
  idempotencyKey: string;
  desiredPickupAt: string | null;
  originalPrescriptionConsent: boolean;
  readinessNoticeConsent: boolean;
}

export async function reservePrescriptionDraft(
  db: D1Database,
  patient: PrescriptionPatient,
  input: ReserveDraftInput,
): Promise<PrescriptionDraft> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    throw new Error('invalid idempotency key');
  }
  const now = new Date().toISOString();
  const submissionId = crypto.randomUUID();
  await db.batch([db.prepare(
    `INSERT INTO pharmacy_prescription_submissions
       (id, line_account_id, friend_id, idempotency_key, status,
        upload_revision, desired_pickup_at, original_prescription_consent_at,
        readiness_notice_consent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id, friend_id, idempotency_key) DO NOTHING`,
  ).bind(
    submissionId,
    patient.lineAccountId,
    patient.friendId,
    input.idempotencyKey,
    input.desiredPickupAt,
    input.originalPrescriptionConsent ? now : null,
    input.readinessNoticeConsent ? now : null,
    now,
    now,
  ), db.prepare(
    `INSERT INTO pharmacy_prescription_events
       (id, submission_id, actor_type, actor_id, event_type, revision, created_at)
     SELECT ?, id, 'patient', friend_id, 'revision_reserved', 1, ?
       FROM pharmacy_prescription_submissions
      WHERE id = ? AND line_account_id = ? AND friend_id = ?`,
  ).bind(
    crypto.randomUUID(),
    now,
    submissionId,
    patient.lineAccountId,
    patient.friendId,
  )]);

  const draft = await db.prepare(
    `SELECT id, status, upload_revision, updated_at
       FROM pharmacy_prescription_submissions
      WHERE line_account_id = ? AND friend_id = ? AND idempotency_key = ?`,
  ).bind(
    patient.lineAccountId,
    patient.friendId,
    input.idempotencyKey,
  ).first<PrescriptionDraft>();
  if (!draft) throw new Error('failed to reserve prescription draft');
  return draft;
}

export interface PrescriptionFile {
  id: string;
  r2_key: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  state: 'pending' | 'ready' | 'deleted';
  revision: number;
  position: number;
}

export async function reservePrescriptionFile(
  db: D1Database,
  patient: PrescriptionPatient,
  submissionId: string,
  position: number,
  image: { contentType: string; byteSize: number; sha256: string },
): Promise<PrescriptionFile> {
  if (!Number.isInteger(position) || position < 1 || position > 4) {
    throw new Error('invalid prescription file position');
  }
  const now = new Date().toISOString();
  const fileId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO pharmacy_prescription_files
       (id, submission_id, revision, position, r2_key, content_type,
        byte_size, sha256, state, created_at, updated_at)
     SELECT ?, s.id, s.upload_revision, ?, ? || s.upload_revision || ?, ?, ?, ?, 'pending', ?, ?
       FROM pharmacy_prescription_submissions s
      WHERE s.id = ? AND s.line_account_id = ? AND s.friend_id = ?
        AND s.status IN ('draft','needs_resubmission')
     ON CONFLICT(submission_id, revision, position) DO NOTHING`,
  ).bind(
    fileId,
    position,
    `custom/pharmacy/prescriptions/${submissionId}/`,
    `/${fileId}`,
    image.contentType,
    image.byteSize,
    image.sha256,
    now,
    now,
    submissionId,
    patient.lineAccountId,
    patient.friendId,
  ).run();

  const file = await db.prepare(
    `SELECT f.id, f.r2_key, f.content_type, f.byte_size, f.sha256,
            f.state, f.revision, f.position
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
      WHERE f.submission_id = ? AND s.line_account_id = ? AND s.friend_id = ?
        AND f.revision = s.upload_revision AND f.position = ?`,
  ).bind(
    submissionId,
    patient.lineAccountId,
    patient.friendId,
    position,
  ).first<PrescriptionFile>();
  if (!file) throw new Error('prescription submission not found');
  if (
    file.content_type !== image.contentType ||
    file.byte_size !== image.byteSize ||
    file.sha256 !== image.sha256
  ) {
    throw new Error('prescription file position conflict');
  }
  return file;
}

export async function markPrescriptionFileReady(
  db: D1Database,
  patient: PrescriptionPatient,
  submissionId: string,
  fileId: string,
  sha256: string,
): Promise<void> {
  const result = await db.prepare(
    `UPDATE pharmacy_prescription_files AS f
        SET state = 'ready', updated_at = ?
      WHERE f.id = ? AND f.submission_id = ? AND f.sha256 = ? AND f.state = 'pending'
        AND EXISTS (
          SELECT 1 FROM pharmacy_prescription_submissions s
           WHERE s.id = f.submission_id
             AND s.line_account_id = ? AND s.friend_id = ?
             AND f.revision = s.upload_revision
        )`,
  ).bind(
    new Date().toISOString(),
    fileId,
    submissionId,
    sha256,
    patient.lineAccountId,
    patient.friendId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription file ready conflict');
  }
}

export async function submitPrescription(
  db: D1Database,
  patient: PrescriptionPatient,
  submissionId: string,
  expectedUpdatedAt: string,
): Promise<void> {
  const now = nextIsoTimestamp(expectedUpdatedAt);
  const results = await db.batch([
    db.prepare(
      `UPDATE pharmacy_prescription_submissions
          SET status = 'received', active_revision = upload_revision,
              requested_at = ?, resubmission_reason_code = NULL, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND friend_id = ?
          AND updated_at = ? AND status IN ('draft','needs_resubmission')
          AND original_prescription_consent_at IS NOT NULL
          AND readiness_notice_consent_at IS NOT NULL
          AND (SELECT COUNT(*) FROM pharmacy_prescription_files f
                WHERE f.submission_id = id AND f.revision = upload_revision)
              = (SELECT COUNT(*) FROM pharmacy_prescription_files f
                  WHERE f.submission_id = id AND f.revision = upload_revision
                    AND f.state = 'ready')
          AND EXISTS (
            SELECT 1 FROM pharmacy_prescription_files f
             WHERE f.submission_id = id AND f.revision = upload_revision
               AND f.state = 'ready'
             GROUP BY f.submission_id, f.revision
            HAVING COUNT(*) BETWEEN 1 AND 4
               AND MIN(f.position) = 1
               AND MAX(f.position) = COUNT(*)
          )`,
    ).bind(
      now,
      now,
      submissionId,
      patient.lineAccountId,
      patient.friendId,
      expectedUpdatedAt,
    ),
    db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type,
          from_status, to_status, revision, created_at)
       SELECT ?, id, 'patient', friend_id, 'status_changed',
              CASE WHEN upload_revision = 1 THEN 'draft' ELSE 'needs_resubmission' END,
              'received', upload_revision, ?
         FROM pharmacy_prescription_submissions
        WHERE id = ? AND line_account_id = ? AND friend_id = ?
          AND status = 'received' AND updated_at = ?`,
    ).bind(
      crypto.randomUUID(),
      now,
      submissionId,
      patient.lineAccountId,
      patient.friendId,
      now,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription submit conflict');
  }
}

export interface PrescriptionHistoryItem {
  id: string;
  status: string;
  active_revision: number | null;
  upload_revision: number;
  desired_pickup_at: string | null;
  resubmission_reason_code: string | null;
  requested_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listPrescriptionHistory(
  db: D1Database,
  patient: PrescriptionPatient,
): Promise<PrescriptionHistoryItem[]> {
  const result = await db.prepare(
    `SELECT id, status, active_revision, upload_revision, desired_pickup_at,
            resubmission_reason_code, requested_at, closed_at, created_at, updated_at
       FROM pharmacy_prescription_submissions
      WHERE line_account_id = ? AND friend_id = ?
      ORDER BY created_at DESC, id DESC`,
  ).bind(patient.lineAccountId, patient.friendId).all<PrescriptionHistoryItem>();
  return result.results;
}

export interface PrescriptionObjectRef {
  id: string;
  r2_key: string;
}

export async function cancelPrescription(
  db: D1Database,
  patient: PrescriptionPatient,
  submissionId: string,
  expectedUpdatedAt: string,
): Promise<PrescriptionObjectRef[]> {
  const now = nextIsoTimestamp(expectedUpdatedAt);
  const results = await db.batch([
    db.prepare(
      `UPDATE pharmacy_prescription_submissions
          SET status = 'cancelled', closed_at = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND friend_id = ?
          AND updated_at = ? AND status IN ('draft','received')`,
    ).bind(
      now, now, submissionId, patient.lineAccountId, patient.friendId, expectedUpdatedAt,
    ),
    db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type,
          from_status, to_status, reason_code, created_at)
       SELECT ?, id, 'patient', friend_id, 'status_changed',
              CASE WHEN active_revision IS NULL THEN 'draft' ELSE 'received' END,
              'cancelled', 'patient_cancelled', ?
         FROM pharmacy_prescription_submissions
        WHERE id = ? AND line_account_id = ? AND friend_id = ?
          AND status = 'cancelled' AND updated_at = ?`,
    ).bind(
      crypto.randomUUID(), now, submissionId, patient.lineAccountId, patient.friendId, now,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription cancel conflict');
  }
  const files = await db.prepare(
    `SELECT f.id, f.r2_key
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
      WHERE f.submission_id = ? AND s.line_account_id = ? AND s.friend_id = ?
        AND f.state != 'deleted'
      ORDER BY f.revision, f.position`,
  ).bind(submissionId, patient.lineAccountId, patient.friendId).all<PrescriptionObjectRef>();
  return files.results;
}

export async function reservePrescriptionResubmission(
  db: D1Database,
  patient: PrescriptionPatient,
  submissionId: string,
  expectedUpdatedAt: string,
): Promise<void> {
  const now = nextIsoTimestamp(expectedUpdatedAt);
  const results = await db.batch([
    db.prepare(
      `UPDATE pharmacy_prescription_submissions
          SET upload_revision = upload_revision + 1, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND friend_id = ?
          AND updated_at = ? AND status = 'needs_resubmission'`,
    ).bind(now, submissionId, patient.lineAccountId, patient.friendId, expectedUpdatedAt),
    db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type, revision, created_at)
       SELECT ?, id, 'patient', friend_id, 'revision_reserved', upload_revision, ?
         FROM pharmacy_prescription_submissions
        WHERE id = ? AND line_account_id = ? AND friend_id = ?
          AND status = 'needs_resubmission' AND updated_at = ?`,
    ).bind(
      crypto.randomUUID(), now, submissionId, patient.lineAccountId, patient.friendId, now,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription resubmission conflict');
  }
}

export async function markPrescriptionFileDeleted(
  db: D1Database,
  patient: PrescriptionPatient,
  submissionId: string,
  fileId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE pharmacy_prescription_files AS f
          SET state = 'deleted', updated_at = ?
        WHERE f.id = ? AND f.submission_id = ? AND f.state != 'deleted'
          AND EXISTS (
            SELECT 1 FROM pharmacy_prescription_submissions s
             WHERE s.id = f.submission_id
               AND s.line_account_id = ? AND s.friend_id = ?
          )`,
    ).bind(now, fileId, submissionId, patient.lineAccountId, patient.friendId),
    db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, event_type, revision, created_at)
       SELECT ?, f.submission_id, 'system', 'file_deleted', f.revision, ?
         FROM pharmacy_prescription_files f
         INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
        WHERE f.id = ? AND f.submission_id = ? AND f.state = 'deleted'
          AND f.updated_at = ? AND s.line_account_id = ? AND s.friend_id = ?`,
    ).bind(
      crypto.randomUUID(), now, fileId, submissionId, now,
      patient.lineAccountId, patient.friendId,
    ),
  ]);
}

export interface AdminQueueItem {
  id: string;
  friend_id: string;
  status: PrescriptionStatus;
  desired_pickup_at: string | null;
  requested_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listAdminPrescriptionQueue(
  db: D1Database,
  lineAccountId: string,
  options: {
    status: PrescriptionStatus | null;
    cursor: { requestedAt: string; id: string } | null;
    limit: number;
  },
): Promise<AdminQueueItem[]> {
  const conditions = ['s.line_account_id = ?'];
  const values: unknown[] = [lineAccountId];
  if (options.status) {
    conditions.push('s.status = ?');
    values.push(options.status);
  }
  if (options.cursor) {
    conditions.push(
      '(COALESCE(s.requested_at, s.created_at) > ? OR ' +
      '(COALESCE(s.requested_at, s.created_at) = ? AND s.id > ?))',
    );
    values.push(options.cursor.requestedAt, options.cursor.requestedAt, options.cursor.id);
  }
  values.push(Math.min(100, Math.max(1, options.limit)));
  const result = await db.prepare(
    `SELECT s.id, s.friend_id, s.status, s.desired_pickup_at,
            s.requested_at, s.created_at, s.updated_at
       FROM pharmacy_prescription_submissions s
      WHERE ${conditions.join(' AND ')}
      ORDER BY COALESCE(s.requested_at, s.created_at), s.id
      LIMIT ?`,
  ).bind(...values).all<AdminQueueItem>();
  return result.results;
}

export interface AdminPrescriptionFile {
  r2_key: string;
  content_type: string;
}

export async function getAdminPrescriptionFile(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  fileId: string,
): Promise<AdminPrescriptionFile | null> {
  return db.prepare(
    `SELECT f.r2_key, f.content_type
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
      WHERE f.submission_id = ? AND f.id = ? AND s.line_account_id = ?
        AND f.state = 'ready'`,
  ).bind(submissionId, fileId, lineAccountId).first<AdminPrescriptionFile>();
}

export interface AdminPrescriptionStats {
  pending_count: number;
  oldest_wait_at: string | null;
}

export async function getAdminPrescriptionStats(
  db: D1Database,
  lineAccountId: string,
): Promise<AdminPrescriptionStats> {
  return (await db.prepare(
    `SELECT COUNT(*) AS pending_count, MIN(requested_at) AS oldest_wait_at
       FROM pharmacy_prescription_submissions
      WHERE line_account_id = ? AND status = 'received'`,
  ).bind(lineAccountId).first<AdminPrescriptionStats>()) ?? {
    pending_count: 0,
    oldest_wait_at: null,
  };
}

export async function getAdminPrescriptionDetail(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
): Promise<{
  submission: Record<string, unknown>;
  files: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
} | null> {
  const submission = await db.prepare(
    `SELECT id, friend_id, status, active_revision, upload_revision,
            desired_pickup_at, resubmission_reason_code, requested_at,
            closed_at, created_at, updated_at
       FROM pharmacy_prescription_submissions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<Record<string, unknown>>();
  if (!submission) return null;
  const files = await db.prepare(
    `SELECT f.id, f.revision, f.position, f.content_type, f.byte_size, f.state,
            f.created_at, f.updated_at
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
      WHERE f.submission_id = ? AND s.line_account_id = ?
      ORDER BY f.revision DESC, f.position`,
  ).bind(submissionId, lineAccountId).all<Record<string, unknown>>();
  const events = await db.prepare(
    `SELECT e.id, e.actor_type, e.actor_id, e.event_type, e.from_status,
            e.to_status, e.reason_code, e.revision, e.created_at
       FROM pharmacy_prescription_events e
       INNER JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id
      WHERE e.submission_id = ? AND s.line_account_id = ?
      ORDER BY e.created_at, e.id`,
  ).bind(submissionId, lineAccountId).all<Record<string, unknown>>();
  return { submission, files: files.results, events: events.results };
}

const RESUBMISSION_REASONS = new Set([
  'blurred', 'cropped', 'glare', 'unreadable', 'missing_page',
]);

export async function applyAdminPrescriptionAction(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  action: PrescriptionAction,
  expectedUpdatedAt: string,
  staffId: string,
  reasonCode: string | null,
): Promise<PrescriptionStatus> {
  const current = await db.prepare(
    `SELECT status, updated_at
       FROM pharmacy_prescription_submissions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<{
    status: PrescriptionStatus;
    updated_at: string;
  }>();
  if (!current || current.updated_at !== expectedUpdatedAt) {
    throw new Error('prescription admin action conflict');
  }
  const next = nextPrescriptionStatus(current.status, action);
  if (
    action === 'admin_request_resubmission' &&
    (!reasonCode || !RESUBMISSION_REASONS.has(reasonCode))
  ) {
    throw new Error('invalid resubmission reason');
  }
  const storedReason = action === 'admin_request_resubmission'
    ? reasonCode
    : action === 'admin_cancel'
      ? 'admin_cancelled'
      : null;
  const now = nextIsoTimestamp(expectedUpdatedAt);
  const results = await db.batch([
    db.prepare(
      `UPDATE pharmacy_prescription_submissions
          SET status = ?, resubmission_reason_code = ?,
              closed_at = CASE WHEN ? IN ('closed','cancelled') THEN ? ELSE closed_at END,
              updated_at = ?
        WHERE id = ? AND line_account_id = ? AND status = ? AND updated_at = ?`,
    ).bind(
      next, action === 'admin_request_resubmission' ? reasonCode : null,
      next, now, now, submissionId, lineAccountId, current.status, expectedUpdatedAt,
    ),
    db.prepare(
      `INSERT INTO pharmacy_prescription_events
         (id, submission_id, actor_type, actor_id, event_type,
          from_status, to_status, reason_code, created_at)
       SELECT ?, id, 'staff', ?, 'status_changed', ?, ?, ?, ?
         FROM pharmacy_prescription_submissions
        WHERE id = ? AND line_account_id = ? AND status = ? AND updated_at = ?`,
    ).bind(
      crypto.randomUUID(), staffId, current.status, next, storedReason, now,
      submissionId, lineAccountId, next, now,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription admin action conflict');
  }
  return next;
}
