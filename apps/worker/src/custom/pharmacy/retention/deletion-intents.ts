import {
  assertRetentionDeleteExecution,
  RetentionDeleteExecution,
} from './execution.js';
import { ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL } from '../data-subject-requests/legal-hold.js';

export type DeletionIntentStatus =
  | 'CLAIMED'
  | 'CANCELLED_HELD'
  | 'CANCELLED_UNKNOWN'
  | 'CANCELLED_STALE'
  | 'DELETE_COMMITTED'
  | 'FINALIZED_DELETED'
  | 'OUTCOME_UNKNOWN';

export interface RetentionFence {
  status: 'held' | 'released' | 'unknown';
  epoch: number;
}

export interface DeletionIntent {
  id: string;
  operation_id: string;
  execution_id: string;
  fence_token: string;
  executor_subject: string;
  environment: string;
  tenant_id: string;
  line_account_id: string;
  owner_friend_id: string;
  patient_key: string;
  resource_type: 'prescription_file' | 'incoming_image';
  resource_id: string;
  r2_key: string;
  stored_sha256: string;
  age_reference_at: string;
  row_state: string;
  row_revision: number;
  hold_epoch: number;
  status: DeletionIntentStatus;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDeletionIntentInput {
  execution: RetentionDeleteExecution;
  tenantId: string;
  lineAccountId: string;
  ownerFriendId: string;
  patientKey: string;
  resourceType: 'prescription_file' | 'incoming_image';
  resourceId: string;
  r2Key: string;
  storedSha256: string;
  ageReferenceAt: string;
  rowState: string;
  rowRevision: number;
  holdEpoch: number;
  now: string;
}

const INTENT_COLUMNS = `id, operation_id, execution_id, fence_token, executor_subject,
  environment, tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
  resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision, hold_epoch, status,
  last_error_code, created_at, updated_at`;

export async function readRetentionFence(
  db: D1Database,
  input: { tenantId: string; lineAccountId: string; ownerFriendId: string; patientKey: string },
): Promise<RetentionFence> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS count, MAX(epoch) AS epoch,
              MAX(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS has_unknown,
              MAX(CASE WHEN status = 'held' THEN 1 ELSE 0 END) AS has_held,
              MAX(CASE WHEN status = 'released' THEN 1 ELSE 0 END) AS has_released
         FROM pharmacy_retention_hold_epochs
        WHERE tenant_id = ? AND line_account_id = ? AND owner_friend_id = ?
          AND patient_key IN (?, '*')`,
    ).bind(input.tenantId, input.lineAccountId, input.ownerFriendId, input.patientKey)
      .first<{ count: number; epoch: number | null; has_unknown: number; has_held: number; has_released: number }>();
    if ((row?.count ?? 0) < 1) return { status: 'unknown', epoch: 0 };
    if (row?.has_unknown === 1) return { status: 'unknown', epoch: row.epoch ?? 0 };
    if (row?.has_held === 1) return { status: 'held', epoch: row.epoch ?? 0 };
    if (row?.has_released === 1) return { status: 'released', epoch: row.epoch ?? 0 };
    return { status: 'unknown', epoch: row?.epoch ?? 0 };
  } catch {
    return { status: 'unknown', epoch: 0 };
  }
}

export async function readDeletionIntent(
  db: D1Database,
  id: string,
): Promise<DeletionIntent | null> {
  return db.prepare(
    `SELECT ${INTENT_COLUMNS} FROM pharmacy_retention_deletion_intents WHERE id = ?`,
  ).bind(id).first<DeletionIntent>();
}

/** Insert one durable claim. The unique generation key makes a second worker a no-op. */
export async function createDeletionIntent(
  db: D1Database,
  input: CreateDeletionIntentInput,
): Promise<DeletionIntent | null> {
  await assertRetentionDeleteExecution(db, input.execution);
  if (input.execution.tenantId !== input.tenantId || input.execution.lineAccountId !== input.lineAccountId) {
    throw new Error('retention deletion execution scope mismatch');
  }
  const id = crypto.randomUUID();
  await assertRetentionDeleteExecution(db, input.execution);
  const result = input.resourceType === 'prescription_file'
    ? await db.prepare(
      `INSERT OR IGNORE INTO pharmacy_retention_deletion_intents
        (id, operation_id, execution_id, fence_token, executor_subject, environment,
         tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
         resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision, hold_epoch,
         status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prescription_file', ?, ?, ?, ?, ?, ?, ?,
              'CLAIMED', ?, ?
         FROM pharmacy_prescription_files AS file
         INNER JOIN pharmacy_prescription_submissions AS submission
                 ON submission.id = file.submission_id
                AND submission.line_account_id = ?
                AND submission.friend_id = ?
        WHERE file.id = ? AND file.r2_key = ? AND file.sha256 = ?
          AND file.created_at = ? AND file.state = ? AND file.revision = ?
          AND EXISTS (
            SELECT 1 FROM tenant_line_accounts AS mapping
             WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?
          )
          AND (
            (? = '*' AND NOT EXISTS (
              SELECT 1 FROM pharmacy_prescription_patients AS mapped
               WHERE mapped.submission_id = file.submission_id
                 AND mapped.line_account_id = ?
            ))
            OR (? <> '*' AND
              (SELECT COUNT(*) FROM pharmacy_prescription_patients AS mapped_count
                WHERE mapped_count.submission_id = file.submission_id
                  AND mapped_count.line_account_id = ?) = 1
              AND EXISTS (
                SELECT 1 FROM pharmacy_prescription_patients AS mapped_patient
                 WHERE mapped_patient.submission_id = file.submission_id
                   AND mapped_patient.line_account_id = ?
                   AND mapped_patient.patient_id = ?
              )
            )
          )`,
    ).bind(
      id, input.execution.operationId, input.execution.executionId, input.execution.fenceToken,
      input.execution.executorSubject, input.execution.environment, input.tenantId,
      input.lineAccountId, input.ownerFriendId, input.patientKey, input.resourceId,
      input.r2Key, input.storedSha256, input.ageReferenceAt, input.rowState, input.rowRevision,
      input.holdEpoch, input.now, input.now, input.lineAccountId, input.ownerFriendId,
      input.resourceId, input.r2Key, input.storedSha256, input.ageReferenceAt, input.rowState,
      input.rowRevision, input.tenantId, input.lineAccountId, input.patientKey,
      input.lineAccountId, input.patientKey, input.lineAccountId, input.lineAccountId,
      input.patientKey,
    ).run()
    : await db.prepare(
      `INSERT OR IGNORE INTO pharmacy_retention_deletion_intents
        (id, operation_id, execution_id, fence_token, executor_subject, environment,
         tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
         resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision, hold_epoch,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?)`,
    ).bind(
      id, input.execution.operationId, input.execution.executionId, input.execution.fenceToken,
      input.execution.executorSubject, input.execution.environment, input.tenantId,
      input.lineAccountId, input.ownerFriendId, input.patientKey, input.resourceType,
      input.resourceId, input.r2Key, input.storedSha256, input.ageReferenceAt,
      input.rowState, input.rowRevision, input.holdEpoch, input.now, input.now,
    ).run();
  if ((result.meta?.changes ?? 0) === 1) return readDeletionIntent(db, id);
  return db.prepare(
    `SELECT ${INTENT_COLUMNS} FROM pharmacy_retention_deletion_intents
      WHERE operation_id = ? AND resource_type = ? AND resource_id = ?
        AND r2_key = ? AND stored_sha256 = ?`,
  ).bind(
    input.execution.operationId, input.resourceType, input.resourceId,
    input.r2Key, input.storedSha256,
  )
    .first<DeletionIntent>();
}

export async function cancelDeletionIntent(
  db: D1Database,
  input: {
    id: string;
    status: Extract<DeletionIntentStatus, 'CANCELLED_HELD' | 'CANCELLED_UNKNOWN' | 'CANCELLED_STALE'>;
    reasonCode: string;
    now: string;
    expectedStatus?: 'CLAIMED' | 'DELETE_COMMITTED' | 'OUTCOME_UNKNOWN';
    execution: RetentionDeleteExecution;
  },
): Promise<boolean> {
  await assertRetentionDeleteExecution(db, input.execution);
  const result = await db.prepare(
    `UPDATE pharmacy_retention_deletion_intents
        SET status = ?, last_error_code = ?, updated_at = ?
      WHERE id = ? AND status = ?
        AND operation_id = ? AND execution_id = ? AND fence_token = ?
        AND executor_subject = ? AND environment = ?
        AND tenant_id = ? AND line_account_id = ?`,
  ).bind(
    input.status, input.reasonCode, input.now, input.id, input.expectedStatus ?? 'CLAIMED',
    input.execution.operationId, input.execution.executionId, input.execution.fenceToken,
    input.execution.executorSubject, input.execution.environment,
    input.execution.tenantId, input.execution.lineAccountId,
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * CAS the intent's linearization point. The hold epoch and current
 * prescription generation are checked in the same UPDATE as the state change.
 */
export async function commitPrescriptionDeletionIntent(
  db: D1Database,
  input: {
    intent: DeletionIntent;
    expectedFence: RetentionFence;
    execution: RetentionDeleteExecution;
    previousHoldEpoch?: number;
    now: string;
  },
): Promise<boolean> {
  const { intent, expectedFence, execution } = input;
  await assertRetentionDeleteExecution(db, execution);
  if (execution.operationId !== intent.operation_id ||
      execution.executionId !== intent.execution_id ||
      execution.fenceToken !== intent.fence_token ||
      execution.executorSubject !== intent.executor_subject ||
      execution.environment !== intent.environment ||
      execution.tenantId !== intent.tenant_id ||
      execution.lineAccountId !== intent.line_account_id) return false;
  const previousHoldEpoch = input.previousHoldEpoch ?? intent.hold_epoch;
  if (expectedFence.status !== 'released' || expectedFence.epoch < 1 ||
      previousHoldEpoch !== intent.hold_epoch) return false;
  const result = await db.prepare(
      `UPDATE pharmacy_retention_deletion_intents AS intent
          SET hold_epoch = ?, status = 'DELETE_COMMITTED', updated_at = ?
        WHERE intent.id = ? AND intent.status = 'CLAIMED'
          AND intent.hold_epoch = ?
          AND intent.operation_id = ? AND intent.execution_id = ?
          AND intent.fence_token = ? AND intent.executor_subject = ?
          AND intent.environment = ? AND intent.tenant_id = ?
          AND intent.line_account_id = ?
          AND EXISTS (
          SELECT 1 FROM pharmacy_retention_hold_epochs AS hold
           WHERE hold.tenant_id = intent.tenant_id
             AND hold.line_account_id = intent.line_account_id
             AND hold.owner_friend_id = intent.owner_friend_id
             AND hold.patient_key IN (intent.patient_key, '*')
             AND hold.status = 'released'
             AND hold.epoch = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_retention_hold_epochs AS blocked
           WHERE blocked.tenant_id = intent.tenant_id
             AND blocked.line_account_id = intent.line_account_id
             AND blocked.owner_friend_id = intent.owner_friend_id
             AND blocked.patient_key IN (intent.patient_key, '*')
             AND blocked.status IN ('held', 'unknown')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_data_subject_requests AS request
           WHERE request.tenant_id = intent.tenant_id
             AND request.line_account_id = intent.line_account_id
             AND request.owner_friend_id = intent.owner_friend_id
             AND (intent.patient_key = '*' OR request.patient_id = intent.patient_key)
             AND request.request_type IN ('erasure', 'suspension')
             AND request.status IN ('received', 'identity_verified', 'legal_hold_assessed')
             AND ${ACTIVE_DSR_DELETION_BLOCK_PREDICATE_SQL}
        )
        AND EXISTS (
          SELECT 1
            FROM pharmacy_prescription_files AS file
            INNER JOIN pharmacy_prescription_submissions AS submission
                    ON submission.id = file.submission_id
                   AND submission.line_account_id = intent.line_account_id
            LEFT JOIN pharmacy_prescription_patients AS patient
                   ON patient.submission_id = file.submission_id
                  AND patient.line_account_id = intent.line_account_id
          WHERE intent.resource_type = 'prescription_file'
            AND file.id = intent.resource_id
            AND file.r2_key = intent.r2_key
            AND file.sha256 = intent.stored_sha256
            AND file.state = intent.row_state
            AND file.revision = intent.row_revision
            AND submission.friend_id = intent.owner_friend_id
            AND (
              (intent.patient_key = '*' AND NOT EXISTS (
                SELECT 1 FROM pharmacy_prescription_patients AS unlinked_patient
                 WHERE unlinked_patient.submission_id = file.submission_id
                   AND unlinked_patient.line_account_id = intent.line_account_id
              ))
              OR (intent.patient_key <> '*' AND
                (SELECT COUNT(*) FROM pharmacy_prescription_patients AS mapped_patient
                  WHERE mapped_patient.submission_id = file.submission_id
                    AND mapped_patient.line_account_id = intent.line_account_id) = 1
                AND patient.patient_id = intent.patient_key)
            )
        )`,
    ).bind(
      expectedFence.epoch, input.now, intent.id, previousHoldEpoch,
      execution.operationId, execution.executionId, execution.fenceToken,
      execution.executorSubject, execution.environment,
      execution.tenantId, execution.lineAccountId, expectedFence.epoch, input.now,
    ).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function markDeletionOutcomeUnknown(
  db: D1Database,
  input: {
    id: string;
    reasonCode: string;
    now: string;
    expectedStatus?: 'CLAIMED' | 'DELETE_COMMITTED';
    execution: RetentionDeleteExecution;
  },
): Promise<boolean> {
  await assertRetentionDeleteExecution(db, input.execution);
  const result = await db.prepare(
    `UPDATE pharmacy_retention_deletion_intents
        SET status = 'OUTCOME_UNKNOWN', last_error_code = ?, updated_at = ?
      WHERE id = ? AND status = ?
        AND operation_id = ? AND execution_id = ? AND fence_token = ?
        AND executor_subject = ? AND environment = ?
        AND tenant_id = ? AND line_account_id = ?`,
  ).bind(
    input.reasonCode, input.now, input.id, input.expectedStatus ?? 'DELETE_COMMITTED',
    input.execution.operationId, input.execution.executionId, input.execution.fenceToken,
    input.execution.executorSubject, input.execution.environment,
    input.execution.tenantId, input.execution.lineAccountId,
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}
