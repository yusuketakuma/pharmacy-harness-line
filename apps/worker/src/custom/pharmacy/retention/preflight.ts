import type { RecoveryPreflight, RecoveryScope } from '../recovery/operations.js';
import { RETENTION_SOURCE_INVENTORY } from '../data-subject-requests/legal-hold.js';

const MAX_INVENTORY_ROWS = 10_000;
const UTC_TIMESTAMP_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
const REQUIRED_TABLES = [
  'messages_log',
  'pharmacy_data_subject_requests',
  'pharmacy_incoming_image_dispositions',
  'pharmacy_incoming_image_objects',
  'pharmacy_prescription_files',
  'pharmacy_prescription_patients',
  'pharmacy_prescription_submissions',
  'pharmacy_recovery_backup_generations',
  'pharmacy_retention_deletion_intents',
  'pharmacy_retention_hold_epochs',
] as const;

type BackupRow = {
  manifest_digest: string;
  expected_row_count: number;
  expected_object_count: number;
};

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cutoffAt(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error('retention preflight timestamp is invalid');
  }
  instant.setUTCFullYear(instant.getUTCFullYear() - 3);
  return instant.toISOString();
}

export async function buildRetentionPreflight(
  db: D1Database,
  input: {
    scope: RecoveryScope;
    backupGenerationId: string;
    operationCreatedAt: string;
  },
): Promise<RecoveryPreflight> {
  const backup = await db.prepare(
    `SELECT manifest_digest, expected_row_count, expected_object_count
       FROM pharmacy_recovery_backup_generations
      WHERE generation_id = ? AND tenant_id = ? AND line_account_id = ?
        AND environment = ? AND status = 'verified' LIMIT 1`,
  ).bind(
    input.backupGenerationId, input.scope.tenantId, input.scope.lineAccountId,
    input.scope.environment,
  ).first<BackupRow>();
  if (!backup) throw new Error('verified backup generation not found');

  const schema = await db.prepare(
    `SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(', ')})
      ORDER BY name`,
  ).bind(...REQUIRED_TABLES).all<{ name: string; sql: string }>();
  if ((schema.results ?? []).length !== REQUIRED_TABLES.length) {
    throw new Error('retention schema inventory is incomplete');
  }

  const cutoff = cutoffAt(input.operationCreatedAt);
  // ponytail: 10k rows per source keeps the admin preflight bounded; page the digest if beta reaches it.
  const prescriptions = await db.prepare(
    `SELECT file.id, file.r2_key, file.sha256, file.revision, file.state, file.created_at,
            submission.friend_id,
            (SELECT COUNT(*) FROM pharmacy_prescription_patients AS patient_count
              WHERE patient_count.submission_id = file.submission_id
                AND patient_count.line_account_id = submission.line_account_id) AS patient_count,
            (SELECT MIN(patient_id) FROM pharmacy_prescription_patients AS patient
              WHERE patient.submission_id = file.submission_id
                AND patient.line_account_id = submission.line_account_id) AS patient_id
       FROM pharmacy_prescription_files AS file
       INNER JOIN pharmacy_prescription_submissions AS submission
               ON submission.id = file.submission_id
       INNER JOIN tenant_line_accounts AS mapping
               ON mapping.line_account_id = submission.line_account_id
              AND mapping.tenant_id = ?
      WHERE submission.line_account_id = ?
        AND file.created_at GLOB ? AND file.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_retention_deletion_intents AS finalized
           WHERE finalized.resource_type = 'prescription_file'
             AND finalized.resource_id = file.id
             AND finalized.status = 'FINALIZED_DELETED'
        )
      ORDER BY file.created_at, file.id LIMIT ?`,
  ).bind(
    input.scope.tenantId, input.scope.lineAccountId, UTC_TIMESTAMP_GLOB, cutoff,
    MAX_INVENTORY_ROWS + 1,
  ).all<Record<string, unknown>>();
  const incoming = await db.prepare(
    `SELECT object.r2_key, object.message_id, object.stored_at,
            disposition.status, disposition.hold_epoch, disposition.stored_sha256
       FROM pharmacy_incoming_image_objects AS object
       LEFT JOIN pharmacy_incoming_image_dispositions AS disposition
              ON disposition.r2_key = object.r2_key
      WHERE object.tenant_id = ? AND object.line_account_id = ?
      ORDER BY object.stored_at, object.r2_key LIMIT ?`,
  ).bind(
    input.scope.tenantId, input.scope.lineAccountId, MAX_INVENTORY_ROWS + 1,
  ).all<Record<string, unknown>>();
  const holds = await db.prepare(
    `SELECT owner_friend_id, patient_key, epoch, status, release_at, updated_at
       FROM pharmacy_retention_hold_epochs
      WHERE tenant_id = ? AND line_account_id = ?
      ORDER BY owner_friend_id, patient_key LIMIT ?`,
  ).bind(
    input.scope.tenantId, input.scope.lineAccountId, MAX_INVENTORY_ROWS + 1,
  ).all<Record<string, unknown>>();
  const requests = await db.prepare(
    `SELECT id, owner_friend_id, patient_id, request_type, status, legal_hold,
            legal_hold_release_at, version, updated_at
       FROM pharmacy_data_subject_requests
      WHERE tenant_id = ? AND line_account_id = ?
      ORDER BY id LIMIT ?`,
  ).bind(
    input.scope.tenantId, input.scope.lineAccountId, MAX_INVENTORY_ROWS + 1,
  ).all<Record<string, unknown>>();
  const inventories = [prescriptions.results, incoming.results, holds.results, requests.results]
    .map((rows) => rows ?? []);
  if (inventories.some((rows) => rows.length > MAX_INVENTORY_ROWS)) {
    throw new Error('retention preflight inventory limit exceeded');
  }

  const [prescriptionRows, incomingRows, holdRows, requestRows] = inventories;
  return {
    schemaDigest: await sha256(schema.results),
    fieldInventoryDigest: await sha256(RETENTION_SOURCE_INVENTORY),
    keyVersions: ['none'],
    backupGenerationId: input.backupGenerationId,
    expectedRowCount: backup.expected_row_count,
    expectedObjectCount: backup.expected_object_count,
    stopPolicy: 'stop-on-drift',
    rollbackPolicy: 'reconcile-only-no-blind-retry',
    evidenceDigest: await sha256({
      scope: input.scope,
      asOf: input.operationCreatedAt,
      cutoff,
      backupManifestDigest: backup.manifest_digest,
      incomingRows,
      holdRows,
      requestRows,
    }),
    rowDigest: await sha256(prescriptionRows),
    coverageTotal: prescriptionRows.length + incomingRows.length,
    coverageVerified: true,
    keyRecoveryAcknowledged: true,
  };
}
