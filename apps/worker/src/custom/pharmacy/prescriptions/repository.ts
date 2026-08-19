import type { PrescriptionPatient } from './patient.js';
import { quoteAllowsAcceptance } from '../fulfillment/repository.js';
import type { FulfillmentStatus } from '../fulfillment/repository.js';
import { markPrescriptionValidityExpiredReview } from '../growth-loop/repository.js';
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
  patientId?: string;
  intakeResponseId?: string;
}

export async function reservePrescriptionDraft(
  db: D1Database,
  patient: PrescriptionPatient,
  input: ReserveDraftInput,
): Promise<PrescriptionDraft> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    throw new Error('invalid idempotency key');
  }
  if ((input.patientId && !input.intakeResponseId) ||
      (!input.patientId && input.intakeResponseId)) {
    throw new Error('invalid patient intake link');
  }
  const hasPatientLink = Boolean(input.patientId && input.intakeResponseId);
  const now = new Date().toISOString();
  const submissionId = crypto.randomUUID();
  const statements = [db.prepare(
    `INSERT INTO pharmacy_prescription_submissions
       (id, line_account_id, friend_id, idempotency_key, status,
        upload_revision, desired_pickup_at, original_prescription_consent_at,
        readiness_notice_consent_at, intake_required, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id, friend_id, idempotency_key) DO NOTHING`,
  ).bind(
    submissionId,
    patient.lineAccountId,
    patient.friendId,
    input.idempotencyKey,
    input.desiredPickupAt,
    input.originalPrescriptionConsent ? now : null,
    input.readinessNoticeConsent ? now : null,
    hasPatientLink ? 1 : 0,
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
  )];
  if (hasPatientLink) {
    statements.push(db.prepare(
      `UPDATE pharmacy_prescription_submissions
          SET intake_required = 1
        WHERE idempotency_key = ? AND line_account_id = ? AND friend_id = ?
          AND status = 'draft'`,
    ).bind(input.idempotencyKey, patient.lineAccountId, patient.friendId));
    statements.push(db.prepare(
      `INSERT INTO pharmacy_prescription_patients
         (submission_id, line_account_id, owner_friend_id, patient_id,
          intake_response_id, created_at)
       SELECT s.id, s.line_account_id, s.friend_id, r.patient_id, r.id, ?
         FROM pharmacy_prescription_submissions s
         INNER JOIN pharmacy_patient_intake_responses r
           ON r.id = ? AND r.patient_id = ?
          AND r.line_account_id = s.line_account_id
          AND r.owner_friend_id = s.friend_id
        WHERE s.idempotency_key = ? AND s.line_account_id = ? AND s.friend_id = ?
          AND s.status = 'draft'
       ON CONFLICT(submission_id) DO NOTHING`,
    ).bind(
      now,
      input.intakeResponseId,
      input.patientId,
      input.idempotencyKey,
      patient.lineAccountId,
      patient.friendId,
    ));
  }
  await db.batch(statements);

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
  if (hasPatientLink) {
    const link = await db.prepare(
      `SELECT patient_id, intake_response_id
         FROM pharmacy_prescription_patients
        WHERE submission_id = ? AND line_account_id = ? AND owner_friend_id = ?`,
    ).bind(draft.id, patient.lineAccountId, patient.friendId).first<{
      patient_id: string;
      intake_response_id: string;
    }>();
    if (!link || link.patient_id !== input.patientId ||
        link.intake_response_id !== input.intakeResponseId) {
      throw new Error('prescription patient link conflict');
    }
  }
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
     SELECT ?, s.id, s.upload_revision, ?,
            'custom/pharmacy/prescriptions/tenants/' || mapping.tenant_id || '/' ||
              s.id || '/' || s.upload_revision || '/' || ?,
            ?, ?, ?, 'pending', ?, ?
       FROM pharmacy_prescription_submissions s
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = s.line_account_id
       INNER JOIN tenants AS tenant
               ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
      WHERE s.id = ? AND s.line_account_id = ? AND s.friend_id = ?
        AND s.status IN ('draft','needs_resubmission')
     ON CONFLICT(submission_id, revision, position) DO NOTHING`,
  ).bind(
    fileId,
    position,
    fileId,
    image.contentType,
    image.byteSize,
    image.sha256,
    now,
    now,
    submissionId,
    patient.lineAccountId,
    patient.friendId,
  ).run();

  // Refresh the exact owned slot before R2 I/O. This fences retention cleanup:
  // either this touch wins, or cleanup has already claimed the file as deleted.
  const touch = await db.prepare(
    `UPDATE pharmacy_prescription_files AS f
        SET updated_at = ?
      WHERE f.submission_id = ? AND f.position = ?
        AND f.content_type = ? AND f.byte_size = ? AND f.sha256 = ?
        AND f.state IN ('pending','ready')
        AND EXISTS (
          SELECT 1 FROM pharmacy_prescription_submissions s
           WHERE s.id = f.submission_id
             AND s.line_account_id = ? AND s.friend_id = ?
             AND f.revision = s.upload_revision
             AND s.status IN ('draft','needs_resubmission')
        )`,
  ).bind(
    now,
    submissionId,
    position,
    image.contentType,
    image.byteSize,
    image.sha256,
    patient.lineAccountId,
    patient.friendId,
  ).run();
  if ((touch.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription file position conflict');
  }

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
): Promise<{ statusEventId: string }> {
  const now = nextIsoTimestamp(expectedUpdatedAt);
  const statusEventId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `UPDATE pharmacy_prescription_submissions AS s
          SET status = 'received', active_revision = upload_revision,
              requested_at = ?, resubmission_reason_code = NULL, updated_at = ?
        WHERE s.id = ? AND s.line_account_id = ? AND s.friend_id = ?
          AND s.updated_at = ? AND s.status IN ('draft','needs_resubmission')
          AND s.original_prescription_consent_at IS NOT NULL
          AND s.readiness_notice_consent_at IS NOT NULL
          AND (SELECT COUNT(*) FROM pharmacy_prescription_files f
                WHERE f.submission_id = s.id AND f.revision = s.upload_revision)
              = (SELECT COUNT(*) FROM pharmacy_prescription_files f
                  WHERE f.submission_id = s.id AND f.revision = s.upload_revision
                    AND f.state = 'ready')
          AND EXISTS (
            SELECT 1 FROM pharmacy_prescription_files f
             WHERE f.submission_id = s.id AND f.revision = s.upload_revision
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
      statusEventId,
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
  return { statusEventId };
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

export async function recordPrescriptionFileViewed(
  db: D1Database,
  lineAccountId: string,
  submissionId: string,
  fileId: string,
  staffId: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO pharmacy_prescription_view_events
       (id, submission_id, file_id, staff_id, viewed_at)
     SELECT ?, f.submission_id, f.id, ?, ?
       FROM pharmacy_prescription_files f
       INNER JOIN pharmacy_prescription_submissions s ON s.id = f.submission_id
      WHERE f.submission_id = ? AND f.id = ? AND s.line_account_id = ?
        AND f.state = 'ready'`,
  ).bind(
    crypto.randomUUID(), staffId, new Date().toISOString(),
    submissionId, fileId, lineAccountId,
  ).run();
}

export interface AdminPrescriptionStats {
  pending_count: number;
  oldest_wait_at: string | null;
}

export interface AdminPrescriptionActionResult {
  status: PrescriptionStatus;
  statusEventId: string;
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
  source: Record<string, unknown> | null;
  validity: Record<string, unknown> | null;
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
  const source = await db.prepare(
    `SELECT ss.source_id, ss.classification, ms.display_name,
            ss.entered_by, ss.entered_at, ss.updated_at
       FROM pharmacy_submission_sources ss
       LEFT JOIN pharmacy_medical_sources ms
         ON ms.id = ss.source_id AND ms.line_account_id = ss.line_account_id
      WHERE ss.submission_id = ? AND ss.line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<Record<string, unknown>>();
  const validity = await db.prepare(
    `SELECT issued_on, valid_until, validity_basis, verification_status,
            verified_by, verified_at, reminder_due_at, reminder_sent_at, updated_at
       FROM pharmacy_prescription_validities
      WHERE submission_id = ? AND line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<Record<string, unknown>>();
  return { submission, files: files.results, events: events.results, source, validity };
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
  atOrOperationId: Date | string | null = null,
  operationId: string | null = null,
): Promise<AdminPrescriptionActionResult> {
  const at = atOrOperationId instanceof Date ? atOrOperationId : new Date();
  const resolvedOperationId = typeof atOrOperationId === 'string' ? atOrOperationId : operationId;
  const eventId = resolvedOperationId ?? crypto.randomUUID();
  if (resolvedOperationId) {
    const replay = await db.prepare(
      `SELECT e.id, e.actor_id, e.from_status, e.to_status, e.reason_code
         FROM pharmacy_prescription_events e
         INNER JOIN pharmacy_prescription_submissions s ON s.id = e.submission_id
        WHERE e.id = ? AND e.submission_id = ? AND s.line_account_id = ?
          AND e.event_type = 'status_changed'`,
    ).bind(resolvedOperationId, submissionId, lineAccountId).first<{
      id: string;
      actor_id: string | null;
      from_status: PrescriptionStatus | null;
      to_status: PrescriptionStatus | null;
      reason_code: string | null;
    }>();
    if (replay) {
      let replayMatches = replay.actor_id === staffId &&
        replay.from_status !== null && replay.to_status !== null;
      if (replayMatches && replay.from_status && replay.to_status) {
        try {
          replayMatches = nextPrescriptionStatus(replay.from_status, action) === replay.to_status;
        } catch {
          replayMatches = false;
        }
      }
      const expectedReason = action === 'admin_request_resubmission'
        ? reasonCode
        : action === 'admin_cancel'
          ? 'admin_cancelled'
          : null;
      if (!replayMatches || replay.reason_code !== expectedReason) {
        throw new Error('prescription admin action idempotency conflict');
      }
      return { status: replay.to_status as PrescriptionStatus, statusEventId: replay.id };
    }
  }
  const current = await db.prepare(
    `SELECT status, updated_at, intake_required, source_handoff_id
       FROM pharmacy_prescription_submissions
      WHERE id = ? AND line_account_id = ?`,
  ).bind(submissionId, lineAccountId).first<{
    status: PrescriptionStatus;
    updated_at: string;
    intake_required?: number;
    source_handoff_id?: string | null;
  }>();
  if (!current || current.updated_at !== expectedUpdatedAt) {
    throw new Error('prescription admin action conflict');
  }
  const next = nextPrescriptionStatus(current.status, action);
  if (action === 'admin_accept') {
    const validity = await db.prepare(
      `SELECT verification_status, valid_until
         FROM pharmacy_prescription_validities
        WHERE submission_id = ? AND line_account_id = ?`,
    ).bind(submissionId, lineAccountId).first<{
      verification_status: 'unverified' | 'verified' | 'expired_review_required' | 'expired_confirmed';
      valid_until: string | null;
    }>();
    if (!validity || validity.verification_status !== 'verified' || !validity.valid_until) {
      throw new Error('prescription validity verification required');
    }
    const localDate = new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (validity.valid_until < localDate) {
      await markPrescriptionValidityExpiredReview(db, {
        lineAccountId,
        submissionId,
        localDate,
        actorId: staffId,
        at,
      });
      throw new Error('prescription validity expired');
    }
  }
  if (action === 'admin_accept' && (current.intake_required === 1 || current.source_handoff_id != null)) {
    const quote = await db.prepare(
      `SELECT decision, requirements_json, status, valid_until
         FROM pharmacy_fulfillment_quotes
        WHERE submission_id = ? AND line_account_id = ?
        ORDER BY revision DESC, created_at DESC, id DESC
        LIMIT 1`,
    ).bind(submissionId, lineAccountId).first<{
      decision: 'fulfillable' | 'conditional' | 'needs_confirmation' | 'not_fulfillable';
      requirements_json: string;
      status: FulfillmentStatus | null;
      valid_until: string | null;
    }>();
    if (!quote) throw new Error('fulfillment quote required');
    let requirements;
    try {
      requirements = JSON.parse(quote.requirements_json) as Array<{
        code: string;
        status: 'pending' | 'satisfied';
      }>;
    } catch {
      throw new Error('fulfillment quote invalid');
    }
    if (!quoteAllowsAcceptance({
      decision: quote.decision,
      requirements,
      status: quote.status,
      validUntil: quote.valid_until,
    }, at)) {
      throw new Error('fulfillment quote not acceptable');
    }
  }
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
      eventId, staffId, current.status, next, storedReason, now,
      submissionId, lineAccountId, next, now,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new Error('prescription admin action conflict');
  }
  return { status: next, statusEventId: eventId };
}
