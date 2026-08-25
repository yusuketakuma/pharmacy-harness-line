// H-5. Durable three-year retention purge for prescription image objects.
//
// A retention worker may mutate only with a V032-1 execution proof. The
// scheduler currently calls this function without one, which is intentionally a
// no-op until the recovery worker supplies the shared proof.

import {
  assertRetentionDeleteExecution,
  RetentionDeleteExecution,
} from '../retention/execution.js';
import {
  cancelDeletionIntent,
  commitPrescriptionDeletionIntent,
  createDeletionIntent,
  DeletionIntent,
  markDeletionOutcomeUnknown,
  readRetentionFence,
  RetentionFence,
} from '../retention/deletion-intents.js';
import { prepareRetentionFence } from '../retention/fence.js';
import {
  isR2RetentionTombstone,
  putR2RetentionTombstone,
  r2ChecksumHex,
} from '../../../services/immutable-r2.js';

export interface PrescriptionRetentionPurgeOptions {
  /** Required for a mutating run; omitted scheduler calls are fail-closed no-ops. */
  execution?: RetentionDeleteExecution;
  now?: Date;
  /** Overridable only so tests do not have to fabricate three-year-old rows. */
  retentionYears?: number;
  limit?: number;
}

interface PurgeCandidate {
  file_id: string;
  r2_key: string;
  sha256: string;
  revision: number;
  state: 'pending' | 'ready' | 'deleted';
  created_at: string;
  tenant_id: string | null;
  line_account_id: string;
  friend_id: string;
  patient_id: string | null;
  patient_mapping_count: number;
}

function intentMatchesExecution(
  intent: DeletionIntent,
  execution: RetentionDeleteExecution,
): boolean {
  return intent.operation_id === execution.operationId &&
    intent.execution_id === execution.executionId &&
    intent.fence_token === execution.fenceToken &&
    intent.executor_subject === execution.executorSubject &&
    intent.environment === execution.environment &&
    intent.tenant_id === execution.tenantId &&
    intent.line_account_id === execution.lineAccountId;
}

async function verifyR2Identity(
  images: R2Bucket,
  intent: DeletionIntent,
): Promise<R2Object | null> {
  let head: R2Object | null;
  try {
    head = await images.head(intent.r2_key);
  } catch {
    return null;
  }
  if (!head || !head.etag || isR2RetentionTombstone(head)) return null;
  return r2ChecksumHex(head.checksums?.sha256) === intent.stored_sha256.toLowerCase()
    ? head : null;
}

export interface RetentionPurgeResult {
  purged: number;
  failed: number;
  skipped: number;
}

const RETENTION_YEARS = 3;
const PURGE_BATCH_LIMIT = 50;

/**
 * Every runtime write of `created_at` is `new Date().toISOString()`. A
 * malformed or offset value is kept: a missed purge is recoverable, a guessed
 * delete is not.
 */
export const UTC_TIMESTAMP_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
const STRICT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Calendar-correct so leap days do not shift the boundary. */
function retentionCutoff(now: Date, years: number): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff.toISOString();
}

async function verifiedExecution(
  db: D1Database,
  execution: RetentionDeleteExecution | undefined,
): Promise<RetentionDeleteExecution | null> {
  if (!execution) return null;
  return assertRetentionDeleteExecution(db, execution);
}

function statusForFence(fence: RetentionFence): 'CANCELLED_HELD' | 'CANCELLED_UNKNOWN' {
  return fence.status === 'held' ? 'CANCELLED_HELD' : 'CANCELLED_UNKNOWN';
}

async function cancelClaim(
  db: D1Database,
  intent: DeletionIntent,
  fence: RetentionFence,
  execution: RetentionDeleteExecution,
  now: string,
): Promise<void> {
  await cancelDeletionIntent(db, {
    id: intent.id,
    status: statusForFence(fence),
    reasonCode: fence.status === 'held' ? 'retention_held' : 'retention_unknown',
    now,
    execution,
  });
}

async function markStale(
  db: D1Database,
  intent: DeletionIntent,
  execution: RetentionDeleteExecution,
  now: string,
): Promise<void> {
  await cancelDeletionIntent(db, {
    id: intent.id,
    status: 'CANCELLED_STALE',
    reasonCode: 'row_generation_changed',
    now,
    execution,
  });
}

async function finalizePrescriptionDeletion(
  db: D1Database,
  intent: DeletionIntent,
  execution: RetentionDeleteExecution,
  now: string,
  retentionYears: number,
): Promise<boolean> {
  try {
    await assertRetentionDeleteExecution(db, execution);
  } catch {
    return false;
  }
  if (!intentMatchesExecution(intent, execution)) return false;
  const existingLog = await db.prepare(
    `SELECT r2_key
       FROM pharmacy_phi_retention_purge_log
      WHERE resource_type = 'prescription_file' AND resource_id = ?`,
  ).bind(intent.resource_id).first<{ r2_key: string | null }>();
  if (existingLog?.r2_key && existingLog.r2_key !== intent.r2_key) {
    await markDeletionOutcomeUnknown(db, {
      id: intent.id,
      reasonCode: 'purge_log_generation_mismatch',
      now,
      execution,
    });
    return false;
  }

  try {
    await assertRetentionDeleteExecution(db, execution);
  } catch {
    return false;
  }
  try {
    const results = await db.batch([
      db.prepare(
        `UPDATE pharmacy_prescription_files
            SET state = 'deleted', updated_at = ?
          WHERE id = ? AND r2_key = ? AND sha256 = ? AND revision = ? AND state = ?
            AND EXISTS (
              SELECT 1 FROM pharmacy_retention_deletion_intents AS intent
               WHERE intent.id = ?
                 AND intent.status IN ('DELETE_COMMITTED', 'OUTCOME_UNKNOWN')
            )`,
      ).bind(now, intent.resource_id, intent.r2_key, intent.stored_sha256,
        intent.row_revision, intent.row_state, intent.id),
      db.prepare(
        `INSERT OR IGNORE INTO pharmacy_phi_retention_purge_log
           (id, tenant_id, line_account_id, resource_type, resource_id, r2_key,
            age_reference_at, retention_years, purged_at)
         SELECT ?, ?, ?, 'prescription_file', ?, ?, ?, ?, ?
           FROM pharmacy_prescription_files AS file
          WHERE file.id = ? AND file.r2_key = ? AND file.sha256 = ?
            AND file.revision = ? AND file.state = 'deleted'
            AND file.updated_at = ?
            AND EXISTS (
              SELECT 1 FROM pharmacy_retention_deletion_intents AS intent
               WHERE intent.id = ?
                 AND intent.status IN ('DELETE_COMMITTED', 'OUTCOME_UNKNOWN')
            )`,
      ).bind(
        crypto.randomUUID(), intent.tenant_id, intent.line_account_id, intent.resource_id,
        intent.r2_key, intent.age_reference_at, retentionYears, now,
        intent.resource_id, intent.r2_key, intent.stored_sha256, intent.row_revision, now,
        intent.id,
      ),
      db.prepare(
        `UPDATE pharmacy_retention_deletion_intents
            SET status = 'FINALIZED_DELETED', last_error_code = NULL, updated_at = ?
          WHERE id = ? AND status IN ('DELETE_COMMITTED', 'OUTCOME_UNKNOWN')
            AND EXISTS (
              SELECT 1 FROM pharmacy_prescription_files AS file
               WHERE file.id = ? AND file.r2_key = ? AND file.sha256 = ?
                 AND file.revision = ? AND file.state = 'deleted'
                 AND file.updated_at = ?
            )
            AND EXISTS (
              SELECT 1 FROM pharmacy_phi_retention_purge_log AS log
               WHERE log.resource_type = 'prescription_file'
                 AND log.resource_id = ? AND log.r2_key = ?
            )`,
      ).bind(
        now, intent.id, intent.resource_id, intent.r2_key, intent.stored_sha256,
        intent.row_revision, now, intent.resource_id, intent.r2_key,
      ),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 ||
        (results[2]?.meta?.changes ?? 0) !== 1) {
      throw new Error('retention finalize CAS failed');
    }
    return true;
  } catch {
    await markDeletionOutcomeUnknown(db, {
      id: intent.id,
      reasonCode: 'retention_finalize_failed',
      now,
      execution,
    });
    return false;
  }
}

async function purgeCandidate(
  db: D1Database,
  images: R2Bucket,
  candidate: PurgeCandidate,
  execution: RetentionDeleteExecution,
  now: string,
  retentionYears: number,
): Promise<'purged' | 'failed' | 'skipped'> {
  if (!candidate.tenant_id || candidate.patient_mapping_count > 1) return 'skipped';
  const patientKey = candidate.patient_mapping_count === 1 && candidate.patient_id
    ? candidate.patient_id
    : '*';
  const fenceScope = {
    tenantId: candidate.tenant_id,
    lineAccountId: candidate.line_account_id,
    ownerFriendId: candidate.friend_id,
    patientId: patientKey === '*' ? null : patientKey,
  };
  const fence = await prepareRetentionFence(db, fenceScope, new Date(now), execution);
  const intent = await createDeletionIntent(db, {
    execution,
    tenantId: candidate.tenant_id,
    lineAccountId: candidate.line_account_id,
    ownerFriendId: candidate.friend_id,
    patientKey,
    resourceType: 'prescription_file',
    resourceId: candidate.file_id,
    r2Key: candidate.r2_key,
    storedSha256: candidate.sha256,
    ageReferenceAt: candidate.created_at,
    rowState: candidate.state,
    rowRevision: candidate.revision,
    holdEpoch: fence.epoch,
    now,
  });
  if (!intent || intent.status !== 'CLAIMED') return 'skipped';
  if (!intentMatchesExecution(intent, execution)) return 'skipped';

  if (fence.status !== 'released') {
    await cancelClaim(db, intent, fence, execution, now);
    return 'skipped';
  }

  const revalidatedFence = await prepareRetentionFence(db, fenceScope, new Date(now), execution);
  if (revalidatedFence.status !== 'released') {
    await cancelClaim(db, intent, revalidatedFence, execution, now);
    return 'skipped';
  }
  const committed = await commitPrescriptionDeletionIntent(db, {
    intent,
    expectedFence: revalidatedFence,
    previousHoldEpoch: intent.hold_epoch,
    execution,
    now,
  });
  if (!committed) {
    const latestFence = await readRetentionFence(db, {
      tenantId: candidate.tenant_id,
      lineAccountId: candidate.line_account_id,
      ownerFriendId: candidate.friend_id,
      patientKey,
    });
    if (latestFence.status !== 'released') await cancelClaim(db, intent, latestFence, execution, now);
    else await markStale(db, intent, execution, now);
    return 'skipped';
  }

  try {
    await assertRetentionDeleteExecution(db, execution);
  } catch {
    return 'failed';
  }
  const selectedObject = await verifyR2Identity(images, intent);
  if (!selectedObject) {
    await markDeletionOutcomeUnknown(db, {
      id: intent.id,
      reasonCode: 'r2_object_identity_unknown',
      now,
      execution,
    });
    return 'failed';
  }
  try {
    await assertRetentionDeleteExecution(db, execution);
    if (!await putR2RetentionTombstone(images, intent.r2_key, selectedObject.etag)) {
      await markDeletionOutcomeUnknown(db, {
        id: intent.id,
        reasonCode: 'r2_object_identity_changed',
        now,
        execution,
      });
      return 'failed';
    }
  } catch {
    await markDeletionOutcomeUnknown(db, {
      id: intent.id,
      reasonCode: 'r2_disposition_outcome_unknown',
      now,
      execution,
    });
    return 'failed';
  }

  return await finalizePrescriptionDeletion(db, intent, execution, now, retentionYears)
    ? 'purged' : 'failed';
}

export async function purgePrescriptionFilesPastRetention(
  db: D1Database,
  images: R2Bucket,
  options: PrescriptionRetentionPurgeOptions = {},
): Promise<RetentionPurgeResult> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) {
    return { purged: 0, failed: 0, skipped: 0 };
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { purged: 0, failed: 0, skipped: 0 };
  const nowIso = now.toISOString();
  const retentionYears = options.retentionYears ?? RETENTION_YEARS;
  const cutoff = retentionCutoff(now, retentionYears);
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? PURGE_BATCH_LIMIT)));

  const due = await db.prepare(
    `SELECT f.id AS file_id, f.r2_key, f.sha256, f.revision, f.state, f.created_at,
            mapping.tenant_id AS tenant_id, s.line_account_id, s.friend_id,
            (SELECT pp.patient_id
               FROM pharmacy_prescription_patients AS pp
              WHERE pp.submission_id = f.submission_id
                AND pp.line_account_id = s.line_account_id
              LIMIT 1) AS patient_id,
            (SELECT COUNT(*)
               FROM pharmacy_prescription_patients AS pp_count
              WHERE pp_count.submission_id = f.submission_id
                AND pp_count.line_account_id = s.line_account_id) AS patient_mapping_count
       FROM pharmacy_prescription_files AS f
       INNER JOIN pharmacy_prescription_submissions AS s ON s.id = f.submission_id
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = s.line_account_id AND mapping.tenant_id = ?
      WHERE s.line_account_id = ? AND f.created_at GLOB ? AND f.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_retention_deletion_intents AS finalized
           WHERE finalized.resource_type = 'prescription_file'
             AND finalized.resource_id = f.id
             AND finalized.status = 'FINALIZED_DELETED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_retention_deletion_intents AS attempted
           WHERE attempted.operation_id = ?
             AND attempted.resource_type = 'prescription_file'
             AND attempted.resource_id = f.id
        )
      ORDER BY f.created_at, f.id
      LIMIT ?`,
  ).bind(
    execution.tenantId, execution.lineAccountId, UTC_TIMESTAMP_GLOB, cutoff,
    execution.operationId, limit,
  ).all<PurgeCandidate>();

  const result: RetentionPurgeResult = { purged: 0, failed: 0, skipped: 0 };
  for (const candidate of due.results ?? []) {
    if (!STRICT_UTC_TIMESTAMP.test(candidate.created_at) ||
        !Number.isFinite(Date.parse(candidate.created_at))) {
      result.skipped++;
      continue;
    }
    try {
      const outcome = await purgeCandidate(
        db, images, candidate, execution, nowIso, retentionYears,
      );
      result[outcome]++;
    } catch {
      // A proof expiry or source query failure fails this candidate closed and
      // must not allow a later object to be deleted in the same batch.
      result.failed++;
    }
  }
  return result;
}

export interface RetentionReconcileOptions {
  execution?: RetentionDeleteExecution;
  now?: Date;
  limit?: number;
}

/**
 * Reconcile an external outcome without blind retrying a present object. A
 * missing head is the only evidence that permits exactly-once D1 finalization;
 * inspection failure remains OUTCOME_UNKNOWN.
 */
export async function reconcilePrescriptionDeletionIntents(
  db: D1Database,
  images: R2Bucket,
  options: RetentionReconcileOptions = {},
): Promise<RetentionPurgeResult> {
  const execution = await verifiedExecution(db, options.execution);
  if (!execution) return { purged: 0, failed: 0, skipped: 0 };
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return { purged: 0, failed: 0, skipped: 0 };
  const nowIso = now.toISOString();
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? PURGE_BATCH_LIMIT)));
  const rows = await db.prepare(
    `SELECT id, operation_id, execution_id, fence_token, executor_subject, environment,
            tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
            resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision, hold_epoch,
            status, last_error_code, created_at, updated_at
      FROM pharmacy_retention_deletion_intents
      WHERE resource_type = 'prescription_file'
        AND status IN ('DELETE_COMMITTED', 'OUTCOME_UNKNOWN')
        AND tenant_id = ? AND line_account_id = ? AND operation_id = ?
        AND execution_id = ? AND fence_token = ? AND executor_subject = ?
        AND environment = ?
      ORDER BY updated_at, id
      LIMIT ?`,
  ).bind(
    execution.tenantId, execution.lineAccountId, execution.operationId,
    execution.executionId, execution.fenceToken, execution.executorSubject,
    execution.environment, limit,
  ).all<DeletionIntent>();

  const result: RetentionPurgeResult = { purged: 0, failed: 0, skipped: 0 };
  for (const intent of rows.results ?? []) {
    if (!intentMatchesExecution(intent, execution)) {
      result.failed++;
      continue;
    }
    try {
      await assertRetentionDeleteExecution(db, execution);
    } catch {
      result.failed++;
      continue;
    }
    let head: R2Object | null;
    try {
      head = await images.head(intent.r2_key);
    } catch {
      await markDeletionOutcomeUnknown(db, {
        id: intent.id,
        reasonCode: 'r2_inspection_unknown',
        now: nowIso,
        expectedStatus: intent.status === 'DELETE_COMMITTED' ? 'DELETE_COMMITTED' : undefined,
        execution,
      });
      result.failed++;
      continue;
    }
    if (!head || isR2RetentionTombstone(head)) {
      if (await finalizePrescriptionDeletion(db, intent, execution, nowIso, RETENTION_YEARS)) result.purged++;
      else result.failed++;
      continue;
    }
    const fence = await readRetentionFence(db, {
      tenantId: intent.tenant_id,
      lineAccountId: intent.line_account_id,
      ownerFriendId: intent.owner_friend_id,
      patientKey: intent.patient_key,
    });
    if (fence.status !== 'released') {
      const cancelled = await cancelDeletionIntent(db, {
        id: intent.id,
        status: statusForFence(fence),
        reasonCode: fence.status === 'held' ? 'reconciled_held' : 'reconciled_unknown',
        now: nowIso,
        expectedStatus: intent.status === 'DELETE_COMMITTED' ? 'DELETE_COMMITTED' : 'OUTCOME_UNKNOWN',
        execution,
      });
      if (cancelled) result.skipped++;
      else result.failed++;
      continue;
    }
    // A present object with no fresh approval/fence is never retried blindly.
    await markDeletionOutcomeUnknown(db, {
      id: intent.id,
      reasonCode: 'r2_present_without_new_fence',
      now: nowIso,
      expectedStatus: intent.status === 'DELETE_COMMITTED' ? 'DELETE_COMMITTED' : undefined,
      execution,
    });
    result.skipped++;
  }
  return result;
}
