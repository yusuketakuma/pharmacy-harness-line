export const RECOVERY_OPERATIONS = [
  'fle_backfill',
  'plaintext_scrub',
  'plaintext_restore',
  'retention_delete',
  'restore_rehearsal',
] as const;

/** The D1/R2 bindings are the environment authority; request JSON is not. */
export const RECOVERY_ENVIRONMENT = 'current-worker-binding';

export type RecoveryOperation = typeof RECOVERY_OPERATIONS[number];

export type RecoveryPrincipal = {
  issuer: 'platform-admin';
  subject: string;
};

export type RecoveryScope = {
  tenantId: string;
  lineAccountId: string;
  environment: string;
};

export type RecoveryPreflight = {
  schemaDigest: string;
  fieldInventoryDigest: string;
  keyVersions: string[];
  backupGenerationId: string;
  expectedRowCount: number;
  expectedObjectCount: number;
  stopPolicy: string;
  rollbackPolicy: string;
  evidenceDigest: string;
  rowDigest: string;
  coverageTotal: number;
  coverageVerified: boolean;
  keyRecoveryAcknowledged: boolean;
};

export type RecoveryOperationRecord = {
  id: string;
  scope: RecoveryScope;
  operation: RecoveryOperation;
  status: 'created' | 'preflighted' | 'approved' | 'running' | 'completed' | 'stale' | 'failed';
  requestedBySubject: string;
  approverSubject: string | null;
  executorSubject: string | null;
  approvalExpiresAt: string;
  jobId: string;
  idempotencyKey: string;
  preflight: RecoveryPreflight | null;
  executionId: string | null;
  fenceId: string | null;
  fenceToken: string | null;
  cursor: string | null;
  processedRowCount: number;
  processedObjectCount: number;
  lastBatchId: string | null;
  errorCode: string | null;
  createdAt: string;
  approvedAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type RecoveryFenceRecord = {
  fenceId: string;
  operationId: string;
  scope: RecoveryScope;
  executionId: string;
  fenceToken: string;
  ownerSubject: string;
  status: 'active' | 'released';
  expiresAt: string;
  createdAt: string;
  releasedAt: string | null;
};

export type RecoveryExecution = {
  operation: RecoveryOperation;
  operationId: string;
  executionId: string;
  fenceToken: string;
  executorSubject: string;
} & RecoveryScope;

export type RecoveryProgressInput = RecoveryExecution & {
  batchId: string;
  cursor: string | null;
  processedRowCount: number;
  processedObjectCount: number;
};

export class RecoveryOperationError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'SCOPE_NOT_FOUND'
      | 'NOT_FOUND'
      | 'IDEMPOTENCY_CONFLICT'
      | 'PREFLIGHT_REQUIRED'
      | 'PREFLIGHT_BLOCKED'
      | 'STALE'
      | 'APPROVAL_CONFLICT'
      | 'APPROVAL_EXPIRED'
      | 'CLAIM_CONFLICT'
      | 'EXECUTION_NOT_FOUND'
      | 'FENCE_EXPIRED'
      | 'PROGRESS_CONFLICT'
      | 'COMPLETE_CONFLICT'
      | 'STATE_CONFLICT'
      | 'STORAGE_FAILED',
    message = code,
  ) {
    super(message);
    this.name = 'RecoveryOperationError';
  }
}

type OperationRow = {
  id: string;
  tenant_id: string;
  line_account_id: string;
  environment: string;
  operation: RecoveryOperation;
  status: RecoveryOperationRecord['status'];
  requested_by_subject: string;
  approver_subject: string | null;
  executor_subject: string | null;
  approval_expires_at: string;
  job_id: string;
  idempotency_key: string;
  schema_digest: string | null;
  field_inventory_digest: string | null;
  key_versions_json: string | null;
  backup_generation_id: string | null;
  expected_row_count: number | null;
  expected_object_count: number | null;
  stop_policy: string | null;
  rollback_policy: string | null;
  evidence_digest: string | null;
  row_digest: string | null;
  coverage_total: number | null;
  coverage_verified: number | null;
  key_recovery_acknowledged: number | null;
  execution_id: string | null;
  fence_id: string | null;
  fence_token: string | null;
  cursor: string | null;
  processed_row_count: number;
  processed_object_count: number;
  last_batch_id: string | null;
  error_code: string | null;
  created_at: string;
  approved_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type FenceRow = {
  fence_id: string;
  operation_id: string;
  tenant_id: string;
  line_account_id: string;
  environment: string;
  execution_id: string;
  fence_token: string;
  owner_subject: string;
  status: RecoveryFenceRecord['status'];
  expires_at: string;
  created_at: string;
  released_at: string | null;
};

const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validScope(scope: RecoveryScope): boolean {
  return validIdentifier(scope.tenantId) && validIdentifier(scope.lineAccountId) &&
    typeof scope.environment === 'string' && ENVIRONMENT.test(scope.environment);
}

function validPrincipal(principal: RecoveryPrincipal): boolean {
  return principal?.issuer === 'platform-admin' && validIdentifier(principal.subject);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && !Number.isNaN(Date.parse(value));
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function validatePreflight(preflight: RecoveryPreflight): void {
  if (!validDigest(preflight.schemaDigest) || !validDigest(preflight.fieldInventoryDigest) ||
      !validIdentifier(preflight.backupGenerationId) || !validDigest(preflight.evidenceDigest) ||
      !validDigest(preflight.rowDigest) || !Array.isArray(preflight.keyVersions) ||
      preflight.keyVersions.length === 0 || preflight.keyVersions.some((item) => !validIdentifier(item)) ||
      !Number.isSafeInteger(preflight.expectedRowCount) || preflight.expectedRowCount < 0 ||
      !Number.isSafeInteger(preflight.expectedObjectCount) || preflight.expectedObjectCount < 0 ||
      !Number.isSafeInteger(preflight.coverageTotal) || preflight.coverageTotal < 0 ||
      typeof preflight.coverageVerified !== 'boolean' ||
      typeof preflight.keyRecoveryAcknowledged !== 'boolean' ||
      typeof preflight.stopPolicy !== 'string' || preflight.stopPolicy.trim().length === 0 ||
      preflight.stopPolicy.length > 240 ||
      typeof preflight.rollbackPolicy !== 'string' || preflight.rollbackPolicy.trim().length === 0 ||
      preflight.rollbackPolicy.length > 240) {
    throw new RecoveryOperationError('INVALID_INPUT');
  }
}

function validateOperation(operation: RecoveryOperation): void {
  if (!(RECOVERY_OPERATIONS as readonly string[]).includes(operation)) {
    throw new RecoveryOperationError('INVALID_INPUT');
  }
}

function validateScopeAndOperation(scope: RecoveryScope, operation: RecoveryOperation): void {
  if (!validScope(scope)) throw new RecoveryOperationError('INVALID_INPUT');
  validateOperation(operation);
}

function validateApprovalExpiry(value: string): void {
  const expiry = Date.parse(value);
  const now = Date.now();
  if (!validTimestamp(value) || expiry <= now) {
    throw new RecoveryOperationError('INVALID_INPUT');
  }
}

function rowToOperation(row: OperationRow): RecoveryOperationRecord {
  let keyVersions: string[] | null = null;
  if (row.key_versions_json) {
    try {
      const parsed = JSON.parse(row.key_versions_json) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        keyVersions = parsed;
      }
    } catch {
      keyVersions = null;
    }
  }
  const preflight = row.schema_digest && row.field_inventory_digest && keyVersions &&
      row.backup_generation_id && row.expected_row_count !== null &&
      row.expected_object_count !== null && row.stop_policy && row.rollback_policy &&
      row.evidence_digest && row.row_digest && row.coverage_total !== null &&
      row.coverage_verified !== null && row.key_recovery_acknowledged !== null
    ? {
      schemaDigest: row.schema_digest,
      fieldInventoryDigest: row.field_inventory_digest,
      keyVersions,
      backupGenerationId: row.backup_generation_id,
      expectedRowCount: row.expected_row_count,
      expectedObjectCount: row.expected_object_count,
      stopPolicy: row.stop_policy,
      rollbackPolicy: row.rollback_policy,
      evidenceDigest: row.evidence_digest,
      rowDigest: row.row_digest,
      coverageTotal: row.coverage_total,
      coverageVerified: row.coverage_verified === 1,
      keyRecoveryAcknowledged: row.key_recovery_acknowledged === 1,
    } satisfies RecoveryPreflight
    : null;
  return {
    id: row.id,
    scope: {
      tenantId: row.tenant_id,
      lineAccountId: row.line_account_id,
      environment: row.environment,
    },
    operation: row.operation,
    status: row.status,
    requestedBySubject: row.requested_by_subject,
    approverSubject: row.approver_subject,
    executorSubject: row.executor_subject,
    approvalExpiresAt: row.approval_expires_at,
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
    preflight,
    executionId: row.execution_id,
    fenceId: row.fence_id,
    fenceToken: row.fence_token,
    cursor: row.cursor,
    processedRowCount: row.processed_row_count,
    processedObjectCount: row.processed_object_count,
    lastBatchId: row.last_batch_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function rowToFence(row: FenceRow): RecoveryFenceRecord {
  return {
    fenceId: row.fence_id,
    operationId: row.operation_id,
    scope: {
      tenantId: row.tenant_id,
      lineAccountId: row.line_account_id,
      environment: row.environment,
    },
    executionId: row.execution_id,
    fenceToken: row.fence_token,
    ownerSubject: row.owner_subject,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

async function operationById(db: D1Database, operationId: string): Promise<RecoveryOperationRecord | null> {
  const row = await db.prepare(`SELECT id, tenant_id, line_account_id, environment, operation, status,
      requested_by_subject, approver_subject, executor_subject, approval_expires_at,
      job_id, idempotency_key, schema_digest, field_inventory_digest, key_versions_json,
      backup_generation_id, expected_row_count, expected_object_count, stop_policy,
      rollback_policy, evidence_digest, row_digest, coverage_total, coverage_verified,
      key_recovery_acknowledged, execution_id, fence_id, fence_token, cursor,
      processed_row_count, processed_object_count, last_batch_id, error_code,
      created_at, approved_at, claimed_at, completed_at, updated_at
    FROM pharmacy_recovery_operations WHERE id = ? LIMIT 1`).bind(operationId)
    .first<OperationRow>();
  return row ? rowToOperation(row) : null;
}

export async function getRecoveryOperation(
  db: D1Database,
  operationId: string,
): Promise<RecoveryOperationRecord | null> {
  if (!validIdentifier(operationId)) throw new RecoveryOperationError('INVALID_INPUT');
  return operationById(db, operationId);
}

async function requireOperation(
  db: D1Database,
  operationId: string,
  scope: RecoveryScope,
  operation: RecoveryOperation,
): Promise<RecoveryOperationRecord> {
  validateScopeAndOperation(scope, operation);
  if (!validIdentifier(operationId)) throw new RecoveryOperationError('INVALID_INPUT');
  const current = await operationById(db, operationId);
  if (!current) throw new RecoveryOperationError('NOT_FOUND');
  if (current.operation !== operation || current.scope.tenantId !== scope.tenantId ||
      current.scope.lineAccountId !== scope.lineAccountId || current.scope.environment !== scope.environment) {
    throw new RecoveryOperationError('NOT_FOUND');
  }
  return current;
}

async function scopeExists(db: D1Database, scope: RecoveryScope): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS found FROM tenant_line_accounts mapping
    INNER JOIN tenants tenant ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
    WHERE mapping.tenant_id = ? AND mapping.line_account_id = ? LIMIT 1`).bind(
    scope.tenantId, scope.lineAccountId,
  ).first<{ found: number }>();
  return row?.found === 1;
}

async function backupMatches(
  db: D1Database,
  scope: RecoveryScope,
  preflight: RecoveryPreflight,
  operation: RecoveryOperation,
): Promise<boolean> {
  const row = await db.prepare(`SELECT generation_id, manifest_digest,
      expected_row_count, expected_object_count
    FROM pharmacy_recovery_backup_generations
    WHERE generation_id = ? AND tenant_id = ? AND line_account_id = ?
      AND environment = ? AND status = 'verified'
    LIMIT 1`).bind(
    preflight.backupGenerationId, scope.tenantId, scope.lineAccountId, scope.environment,
  ).first<{
    generation_id: string;
    manifest_digest: string;
    expected_row_count: number;
    expected_object_count: number;
  }>();
  return Boolean(row && row.expected_row_count === preflight.expectedRowCount &&
    row.expected_object_count === preflight.expectedObjectCount &&
    // Retention uses a server-built composite evidence digest which already
    // includes this manifest digest and is rebuilt immediately before mutation.
    (operation === 'retention_delete' || row.manifest_digest === preflight.evidenceDigest));
}

function preflightEqual(a: RecoveryPreflight, b: RecoveryPreflight): boolean {
  return a.schemaDigest === b.schemaDigest &&
    a.fieldInventoryDigest === b.fieldInventoryDigest &&
    JSON.stringify(a.keyVersions) === JSON.stringify(b.keyVersions) &&
    a.backupGenerationId === b.backupGenerationId &&
    a.expectedRowCount === b.expectedRowCount &&
    a.expectedObjectCount === b.expectedObjectCount &&
    a.stopPolicy === b.stopPolicy && a.rollbackPolicy === b.rollbackPolicy &&
    a.evidenceDigest === b.evidenceDigest && a.rowDigest === b.rowDigest &&
    a.coverageTotal === b.coverageTotal && a.coverageVerified === b.coverageVerified &&
    a.keyRecoveryAcknowledged === b.keyRecoveryAcknowledged;
}

function requiresFullCoverage(operation: RecoveryOperation): boolean {
  return operation === 'plaintext_scrub' || operation === 'plaintext_restore';
}

async function staleRunningOperation(
  db: D1Database,
  current: RecoveryOperationRecord,
  code: 'PREFLIGHT_BLOCKED' | 'STALE',
): Promise<void> {
  if (current.status !== 'running') return;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE pharmacy_recovery_operations
      SET status = 'stale', error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND execution_id = ?`)
      .bind(code, now, current.id, current.executionId),
    db.prepare(`UPDATE pharmacy_recovery_execution_fences
      SET status = 'released', released_at = ?
      WHERE fence_id = ? AND status = 'active'`)
      .bind(now, current.fenceId),
  ]);
}

export async function createRecoveryApproval(
  db: D1Database,
  input: {
    scope: RecoveryScope;
    operation: RecoveryOperation;
    requestedBy: RecoveryPrincipal;
    approvalExpiresAt: string;
    idempotencyKey: string;
    jobId?: string;
  },
): Promise<RecoveryOperationRecord> {
  validateScopeAndOperation(input.scope, input.operation);
  if (!validPrincipal(input.requestedBy) || !validIdentifier(input.idempotencyKey) ||
      input.idempotencyKey.length > 240) throw new RecoveryOperationError('INVALID_INPUT');
  validateApprovalExpiry(input.approvalExpiresAt);
  if (!await scopeExists(db, input.scope)) throw new RecoveryOperationError('SCOPE_NOT_FOUND');
  const existing = await db.prepare(`SELECT id FROM pharmacy_recovery_operations
    WHERE tenant_id = ? AND line_account_id = ? AND environment = ?
      AND operation = ? AND idempotency_key = ? LIMIT 1`).bind(
    input.scope.tenantId, input.scope.lineAccountId, input.scope.environment,
    input.operation, input.idempotencyKey,
  ).first<{ id: string }>();
  if (existing) {
    const replay = await operationById(db, existing.id);
    if (!replay || replay.requestedBySubject !== input.requestedBy.subject ||
        replay.approvalExpiresAt !== input.approvalExpiresAt) {
      throw new RecoveryOperationError('IDEMPOTENCY_CONFLICT');
    }
    return replay;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const jobId = input.jobId ?? `job-${crypto.randomUUID()}`;
  if (!validIdentifier(jobId)) throw new RecoveryOperationError('INVALID_INPUT');
  try {
    const result = await db.prepare(`INSERT INTO pharmacy_recovery_operations
      (id, tenant_id, line_account_id, environment, operation, status,
       requested_by_issuer, requested_by_subject, approval_expires_at, job_id,
      idempotency_key, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, 'created', 'platform-admin', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM tenant_line_accounts mapping
        INNER JOIN tenants tenant ON tenant.id = mapping.tenant_id AND tenant.status = 'active'
        WHERE mapping.tenant_id = ? AND mapping.line_account_id = ?)`)
      .bind(
        id, input.scope.tenantId, input.scope.lineAccountId, input.scope.environment,
        input.operation, input.requestedBy.subject, input.approvalExpiresAt, jobId,
        input.idempotencyKey, now, now, input.scope.tenantId, input.scope.lineAccountId,
      ).run();
    if (result.meta?.changes !== 1) throw new RecoveryOperationError('SCOPE_NOT_FOUND');
  } catch (error) {
    if (error instanceof RecoveryOperationError) throw error;
    const replay = await db.prepare(`SELECT id FROM pharmacy_recovery_operations
      WHERE tenant_id = ? AND line_account_id = ? AND environment = ?
        AND operation = ? AND idempotency_key = ? LIMIT 1`).bind(
      input.scope.tenantId, input.scope.lineAccountId, input.scope.environment,
      input.operation, input.idempotencyKey,
    ).first<{ id: string }>();
    if (replay) {
      const replayed = await operationById(db, replay.id);
      if (!replayed || replayed.requestedBySubject !== input.requestedBy.subject ||
          replayed.approvalExpiresAt !== input.approvalExpiresAt) {
        throw new RecoveryOperationError('IDEMPOTENCY_CONFLICT');
      }
      return replayed;
    }
    throw new RecoveryOperationError('STORAGE_FAILED');
  }
  return (await operationById(db, id))!;
}

export async function preflightRecoveryOperation(
  db: D1Database,
  input: {
    operationId: string;
    scope: RecoveryScope;
    operation: RecoveryOperation;
    preflight: RecoveryPreflight;
    executionId?: string;
    fenceToken?: string;
  },
): Promise<RecoveryOperationRecord> {
  validatePreflight(input.preflight);
  const current = await requireOperation(db, input.operationId, input.scope, input.operation);
  if (requiresFullCoverage(input.operation) &&
      (!input.preflight.coverageVerified || input.preflight.coverageTotal !== input.preflight.expectedRowCount ||
       !input.preflight.keyRecoveryAcknowledged)) {
    await staleRunningOperation(db, current, 'PREFLIGHT_BLOCKED');
    throw new RecoveryOperationError('PREFLIGHT_BLOCKED');
  }
  if (!await backupMatches(db, input.scope, input.preflight, input.operation)) {
    await staleRunningOperation(db, current, 'STALE');
    throw new RecoveryOperationError('PREFLIGHT_BLOCKED');
  }
  if (current.status === 'running') {
    if (!input.executionId || !input.fenceToken || current.executionId !== input.executionId ||
        current.fenceToken !== input.fenceToken) {
      await staleRunningOperation(db, current, 'STALE');
      throw new RecoveryOperationError('STALE');
    }
    const fence = await db.prepare(`SELECT fence_id FROM pharmacy_recovery_execution_fences
      WHERE fence_id = ? AND operation_id = ? AND execution_id = ? AND fence_token = ?
        AND status = 'active' AND expires_at > ? LIMIT 1`).bind(
      current.fenceId, current.id, input.executionId, input.fenceToken, new Date().toISOString(),
    ).first<{ fence_id: string }>();
    if (!fence || !current.preflight || !preflightEqual(current.preflight, input.preflight)) {
      await staleRunningOperation(db, current, 'STALE');
      throw new RecoveryOperationError('STALE');
    }
    return current;
  }
  if (current.status !== 'created' && current.status !== 'preflighted') {
    throw new RecoveryOperationError('STATE_CONFLICT');
  }
  const now = new Date().toISOString();
  const result = await db.prepare(`UPDATE pharmacy_recovery_operations SET
      status = 'preflighted', schema_digest = ?, field_inventory_digest = ?,
      key_versions_json = ?, backup_generation_id = ?, expected_row_count = ?,
      expected_object_count = ?, stop_policy = ?, rollback_policy = ?,
      evidence_digest = ?, row_digest = ?, coverage_total = ?,
      coverage_verified = ?, key_recovery_acknowledged = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND environment = ?
      AND operation = ? AND status IN ('created', 'preflighted')`)
    .bind(
      input.preflight.schemaDigest, input.preflight.fieldInventoryDigest,
      JSON.stringify(input.preflight.keyVersions), input.preflight.backupGenerationId,
      input.preflight.expectedRowCount, input.preflight.expectedObjectCount,
      input.preflight.stopPolicy, input.preflight.rollbackPolicy, input.preflight.evidenceDigest,
      input.preflight.rowDigest, input.preflight.coverageTotal,
      input.preflight.coverageVerified ? 1 : 0, input.preflight.keyRecoveryAcknowledged ? 1 : 0,
      now, input.operationId, input.scope.tenantId, input.scope.lineAccountId,
      input.scope.environment, input.operation,
    ).run();
  if (result.meta?.changes !== 1) throw new RecoveryOperationError('STATE_CONFLICT');
  return (await operationById(db, input.operationId))!;
}

export async function approveRecoveryOperation(
  db: D1Database,
  input: {
    operationId: string;
    scope: RecoveryScope;
    operation: RecoveryOperation;
    principal: RecoveryPrincipal;
  },
): Promise<RecoveryOperationRecord> {
  if (!validPrincipal(input.principal)) throw new RecoveryOperationError('INVALID_INPUT');
  const current = await requireOperation(db, input.operationId, input.scope, input.operation);
  if (current.status !== 'preflighted' || !current.preflight) {
    throw new RecoveryOperationError(current.status === 'approved' ? 'APPROVAL_CONFLICT' : 'PREFLIGHT_REQUIRED');
  }
  if (Date.parse(current.approvalExpiresAt) <= Date.now()) {
    throw new RecoveryOperationError('APPROVAL_EXPIRED');
  }
  const result = await db.prepare(`UPDATE pharmacy_recovery_operations SET
      status = 'approved', approver_issuer = 'platform-admin', approver_subject = ?,
      approved_at = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND environment = ?
      AND operation = ? AND status = 'preflighted' AND approver_subject IS NULL`)
    .bind(
      input.principal.subject, new Date().toISOString(), new Date().toISOString(),
      input.operationId, input.scope.tenantId, input.scope.lineAccountId,
      input.scope.environment, input.operation,
    ).run();
  if (result.meta?.changes !== 1) throw new RecoveryOperationError('APPROVAL_CONFLICT');
  return (await operationById(db, input.operationId))!;
}

export async function claimRecoveryOperation(
  db: D1Database,
  input: {
    operationId: string;
    scope: RecoveryScope;
    operation: RecoveryOperation;
    executor: RecoveryPrincipal;
  },
): Promise<RecoveryOperationRecord> {
  if (!validPrincipal(input.executor)) throw new RecoveryOperationError('INVALID_INPUT');
  const current = await requireOperation(db, input.operationId, input.scope, input.operation);
  if (current.status !== 'approved' || !current.preflight || !current.approverSubject) {
    throw new RecoveryOperationError('CLAIM_CONFLICT');
  }
  if (Date.parse(current.approvalExpiresAt) <= Date.now()) {
    throw new RecoveryOperationError('APPROVAL_EXPIRED');
  }
  if (current.approverSubject === input.executor.subject) {
    throw new RecoveryOperationError('CLAIM_CONFLICT');
  }
  const fenceId = crypto.randomUUID();
  const executionId = crypto.randomUUID();
  const fenceToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO pharmacy_recovery_execution_fences
      (fence_id, operation_id, tenant_id, line_account_id, environment,
       execution_id, fence_token, owner_issuer, owner_subject, status,
       expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'platform-admin', ?, 'active', ?, ?
      WHERE EXISTS (SELECT 1 FROM pharmacy_recovery_operations
        WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND environment = ?
          AND operation = ? AND status = 'approved' AND approval_expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM pharmacy_recovery_execution_fences
          WHERE tenant_id = ? AND line_account_id = ? AND environment = ? AND status = 'active')`)
      .bind(
        fenceId, input.operationId, input.scope.tenantId, input.scope.lineAccountId,
        input.scope.environment, executionId, fenceToken, input.executor.subject,
        current.approvalExpiresAt, now, input.operationId, input.scope.tenantId,
        input.scope.lineAccountId, input.scope.environment, input.operation, now,
        input.scope.tenantId, input.scope.lineAccountId, input.scope.environment,
      ),
    db.prepare(`UPDATE pharmacy_recovery_operations SET
        status = 'running', executor_issuer = 'platform-admin', executor_subject = ?,
        execution_id = ?, fence_id = ?, fence_token = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND environment = ?
        AND operation = ? AND status = 'approved' AND approval_expires_at > ?
        AND approver_subject IS NOT NULL AND approver_subject <> ?`)
      .bind(
        input.executor.subject, executionId, fenceId, fenceToken, now, now,
        input.operationId, input.scope.tenantId, input.scope.lineAccountId,
        input.scope.environment, input.operation, now, input.executor.subject,
      ),
  ]);
  if (results.length !== 2 || results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
    throw new RecoveryOperationError('CLAIM_CONFLICT');
  }
  return (await operationById(db, input.operationId))!;
}

export async function assertRecoveryExecution(
  db: D1Database,
  input: RecoveryExecution,
): Promise<{ operation: RecoveryOperationRecord; fence: RecoveryFenceRecord }> {
  validateScopeAndOperation(input, input.operation);
  if (!validIdentifier(input.operationId) || !validIdentifier(input.executionId) ||
      typeof input.fenceToken !== 'string' || input.fenceToken.length < 32 ||
      !validIdentifier(input.executorSubject)) {
    throw new RecoveryOperationError('INVALID_INPUT');
  }
  const row = await db.prepare(`SELECT
      operation.id, operation.tenant_id, operation.line_account_id, operation.environment,
      operation.operation, operation.status, operation.requested_by_subject,
      operation.approver_subject, operation.executor_subject, operation.approval_expires_at,
      operation.job_id, operation.idempotency_key, operation.schema_digest,
      operation.field_inventory_digest, operation.key_versions_json,
      operation.backup_generation_id, operation.expected_row_count,
      operation.expected_object_count, operation.stop_policy, operation.rollback_policy,
      operation.evidence_digest, operation.row_digest, operation.coverage_total,
      operation.coverage_verified, operation.key_recovery_acknowledged,
      operation.execution_id, operation.fence_id, operation.fence_token, operation.cursor,
      operation.processed_row_count, operation.processed_object_count,
      operation.last_batch_id, operation.error_code, operation.created_at,
      operation.approved_at, operation.claimed_at, operation.completed_at, operation.updated_at,
      fence.fence_id AS live_fence_id, fence.operation_id AS live_operation_id,
      fence.tenant_id AS live_tenant_id, fence.line_account_id AS live_line_account_id,
      fence.environment AS live_environment, fence.execution_id AS live_execution_id,
      fence.fence_token AS live_fence_token, fence.owner_subject AS live_owner_subject,
      fence.status AS live_status, fence.expires_at AS live_expires_at,
      fence.created_at AS live_created_at, fence.released_at AS live_released_at
    FROM pharmacy_recovery_operations operation
    INNER JOIN pharmacy_recovery_execution_fences fence
      ON fence.fence_id = operation.fence_id
    WHERE operation.id = ? AND operation.tenant_id = ? AND operation.line_account_id = ?
      AND operation.environment = ? AND operation.operation = ?
      AND operation.status = 'running' AND operation.execution_id = ?
      AND operation.fence_token = ? AND operation.executor_subject = ?
      AND fence.operation_id = operation.id AND fence.execution_id = operation.execution_id
      AND fence.fence_token = operation.fence_token AND fence.owner_subject = ?
      AND fence.tenant_id = operation.tenant_id
      AND fence.line_account_id = operation.line_account_id
      AND fence.environment = operation.environment
      AND fence.status = 'active' AND fence.expires_at > ?
    LIMIT 1`).bind(
    input.operationId, input.tenantId, input.lineAccountId, input.environment,
    input.operation, input.executionId, input.fenceToken, input.executorSubject,
    input.executorSubject, new Date().toISOString(),
  ).first<OperationRow & {
    live_fence_id: string;
    live_operation_id: string;
    live_tenant_id: string;
    live_line_account_id: string;
    live_environment: string;
    live_execution_id: string;
    live_fence_token: string;
    live_owner_subject: string;
    live_status: RecoveryFenceRecord['status'];
    live_expires_at: string;
    live_created_at: string;
    live_released_at: string | null;
  }>();
  if (!row) throw new RecoveryOperationError('EXECUTION_NOT_FOUND');
  const operationRow = rowToOperation(row);
  const fence = rowToFence({
    fence_id: row.live_fence_id,
    operation_id: row.live_operation_id,
    tenant_id: row.live_tenant_id,
    line_account_id: row.live_line_account_id,
    environment: row.live_environment,
    execution_id: row.live_execution_id,
    fence_token: row.live_fence_token,
    owner_subject: row.live_owner_subject,
    status: row.live_status,
    expires_at: row.live_expires_at,
    created_at: row.live_created_at,
    released_at: row.live_released_at,
  });
  if (Date.parse(fence.expiresAt) <= Date.now()) throw new RecoveryOperationError('FENCE_EXPIRED');
  return { operation: operationRow, fence };
}

export async function assertRecoveryFence(
  db: D1Database,
  scope: RecoveryScope,
): Promise<RecoveryFenceRecord | null> {
  if (!validScope(scope)) throw new RecoveryOperationError('INVALID_INPUT');
  const row = await db.prepare(`SELECT fence_id, operation_id, tenant_id, line_account_id,
      environment, execution_id, fence_token, owner_subject, status, expires_at,
      created_at, released_at
    FROM pharmacy_recovery_execution_fences
    WHERE tenant_id = ? AND line_account_id = ? AND environment = ?
      AND status = 'active' AND expires_at > ? LIMIT 1`).bind(
    scope.tenantId, scope.lineAccountId, scope.environment, new Date().toISOString(),
  ).first<FenceRow>();
  return row ? rowToFence(row) : null;
}

export async function markRecoveryProgress(
  db: D1Database,
  input: RecoveryProgressInput,
): Promise<RecoveryOperationRecord> {
  const current = (await assertRecoveryExecution(db, input)).operation;
  if (!validIdentifier(input.batchId) || input.batchId.length > 240 ||
      (input.cursor !== null && !validIdentifier(input.cursor)) ||
      !Number.isSafeInteger(input.processedRowCount) || input.processedRowCount < current.processedRowCount ||
      !Number.isSafeInteger(input.processedObjectCount) || input.processedObjectCount < current.processedObjectCount ||
      !current.preflight || input.processedRowCount > current.preflight.expectedRowCount ||
      input.processedObjectCount > current.preflight.expectedObjectCount) {
    throw new RecoveryOperationError('INVALID_INPUT');
  }
  if (current.lastBatchId === input.batchId) {
    if (current.cursor !== input.cursor || current.processedRowCount !== input.processedRowCount ||
        current.processedObjectCount !== input.processedObjectCount) {
      throw new RecoveryOperationError('PROGRESS_CONFLICT');
    }
    return current;
  }
  const result = await db.prepare(`UPDATE pharmacy_recovery_operations SET
      cursor = ?, processed_row_count = ?, processed_object_count = ?,
      last_batch_id = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND environment = ?
      AND operation = ? AND status = 'running' AND execution_id = ?
      AND fence_token = ? AND executor_subject = ?
      AND (last_batch_id IS NULL OR last_batch_id <> ?)`)
    .bind(
      input.cursor, input.processedRowCount, input.processedObjectCount, input.batchId,
      new Date().toISOString(), input.operationId, input.tenantId, input.lineAccountId,
      input.environment, input.operation, input.executionId, input.fenceToken,
      input.executorSubject, input.batchId,
    ).run();
  if (result.meta?.changes !== 1) throw new RecoveryOperationError('PROGRESS_CONFLICT');
  return (await operationById(db, input.operationId))!;
}

function releaseFenceStatement(db: D1Database, fenceId: string, now: string): D1PreparedStatement {
  return db.prepare(`UPDATE pharmacy_recovery_execution_fences
    SET status = 'released', released_at = ?
    WHERE fence_id = ? AND status = 'active'`).bind(now, fenceId);
}

export async function completeRecoveryOperation(
  db: D1Database,
  input: RecoveryExecution,
): Promise<RecoveryOperationRecord> {
  const current = (await assertRecoveryExecution(db, input)).operation;
  if (!current.preflight || current.processedRowCount !== current.preflight.expectedRowCount ||
      current.processedObjectCount !== current.preflight.expectedObjectCount) {
    throw new RecoveryOperationError('COMPLETE_CONFLICT');
  }
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE pharmacy_recovery_operations SET
        status = 'completed', completed_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND line_account_id = ? AND environment = ?
        AND operation = ? AND status = 'running' AND execution_id = ?
        AND fence_token = ? AND executor_subject = ?`)
      .bind(
        now, now, current.id, input.tenantId, input.lineAccountId, input.environment,
        input.operation, input.executionId, input.fenceToken, input.executorSubject,
      ),
    releaseFenceStatement(db, current.fenceId!, now),
  ]);
  if (results.length !== 2 || results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
    throw new RecoveryOperationError('COMPLETE_CONFLICT');
  }
  return (await operationById(db, current.id))!;
}

export async function markRecoveryStale(
  db: D1Database,
  input: {
    operationId: string;
    scope: RecoveryScope;
    operation: RecoveryOperation;
    code?: string;
  },
): Promise<RecoveryOperationRecord> {
  const current = await requireOperation(db, input.operationId, input.scope, input.operation);
  if (current.status === 'completed' || current.status === 'failed' || current.status === 'stale') return current;
  const errorCode = input.code ?? 'STALE';
  if (!validIdentifier(errorCode)) throw new RecoveryOperationError('INVALID_INPUT');
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE pharmacy_recovery_operations SET status = 'stale', error_code = ?, updated_at = ?
      WHERE id = ? AND status IN ('created', 'preflighted', 'approved', 'running')`)
      .bind(errorCode, now, current.id),
    current.fenceId
      ? releaseFenceStatement(db, current.fenceId, now)
      : db.prepare(`SELECT 1 WHERE 0`),
  ]);
  if (results[0]?.meta?.changes !== 1) throw new RecoveryOperationError('STATE_CONFLICT');
  return (await operationById(db, current.id))!;
}

export async function markRecoveryFailed(
  db: D1Database,
  input: {
    operationId: string;
    scope: RecoveryScope;
    operation: RecoveryOperation;
    code?: string;
  },
): Promise<RecoveryOperationRecord> {
  const current = await requireOperation(db, input.operationId, input.scope, input.operation);
  if (current.status === 'completed' || current.status === 'failed' || current.status === 'stale') return current;
  const errorCode = input.code ?? 'FAILED';
  if (!validIdentifier(errorCode)) throw new RecoveryOperationError('INVALID_INPUT');
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`UPDATE pharmacy_recovery_operations SET status = 'failed', error_code = ?, updated_at = ?
      WHERE id = ? AND status IN ('created', 'preflighted', 'approved', 'running')`)
      .bind(errorCode, now, current.id),
    current.fenceId
      ? releaseFenceStatement(db, current.fenceId, now)
      : db.prepare(`SELECT 1 WHERE 0`),
  ]);
  if (results[0]?.meta?.changes !== 1) throw new RecoveryOperationError('STATE_CONFLICT');
  return (await operationById(db, current.id))!;
}
