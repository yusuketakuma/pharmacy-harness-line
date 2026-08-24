import { Hono, type Context } from 'hono';
import type { Env } from '../../../index.js';
import {
  assertRecoveryExecution,
  approveRecoveryOperation,
  claimRecoveryOperation,
  completeRecoveryOperation,
  createRecoveryApproval,
  getRecoveryOperation,
  markRecoveryFailed,
  markRecoveryProgress,
  markRecoveryStale,
  preflightRecoveryOperation,
  RECOVERY_ENVIRONMENT,
  RECOVERY_OPERATIONS,
  RecoveryOperationError,
  type RecoveryOperation,
  type RecoveryPreflight,
  type RecoveryPrincipal,
  type RecoveryScope,
} from '../recovery/operations.js';
import {
  backfillPatientIntakeEnvelopes,
  freezePatientIntakeWrites,
  inspectPatientIntakeBackfillCoverage,
  inspectPatientIntakeCoverage,
  patientIntakeRecoveryMetadata,
  restorePatientIntakeLegacyFields,
  scrubPatientIntakeLegacyFields,
  type PatientIntakeMigrationApproval,
} from '../intake/migration.js';
import {
  purgePrescriptionFilesPastRetention,
  reconcilePrescriptionDeletionIntents,
} from '../prescriptions/retention-purge.js';
import {
  backfillIncomingImageTracking,
  incomingImageRetentionReadiness,
  purgeTrackedIncomingImages,
  reconcileIncomingImageDeletionOutcomes,
  reconcileIncomingImageInventory,
} from '../retention/incoming-images.js';
import { buildRetentionPreflight } from '../retention/preflight.js';
import { recordPlatformAdminAccess } from './audit.js';

export const platformAdminDataProtectionRoutes = new Hono<Env>();

const RECOVERY_PATH = '/api/platform-admin/data-protection/recovery-operations';
const MAX_BATCH = 50;
const encoder = new TextEncoder();

type Body = Record<string, unknown>;
type RecoveryContext = Context<Env>;

function asBody(value: unknown): Body | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Body
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null;
}

function operationValue(value: unknown): RecoveryOperation | null {
  return typeof value === 'string' && (RECOVERY_OPERATIONS as readonly string[]).includes(value)
    ? value as RecoveryOperation
    : null;
}

const IDENTITY_KEYS = new Set([
  'approvedBy', 'approved_by', 'approver', 'approverSubject', 'approver_subject',
  'executor', 'executorBy', 'executorSubject', 'executor_subject',
]);

function identitySpoofed(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(identitySpoofed);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Body).some(([key, nested]) =>
    IDENTITY_KEYS.has(key) || identitySpoofed(nested));
}

function scopeFromBody(body: Body): RecoveryScope | null {
  const tenantId = stringValue(body.tenantId);
  const lineAccountId = stringValue(body.lineAccountId);
  const environment = stringValue(body.environment);
  return tenantId && lineAccountId && environment === RECOVERY_ENVIRONMENT
    ? { tenantId, lineAccountId, environment: RECOVERY_ENVIRONMENT }
    : null;
}

function principal(c: RecoveryContext): RecoveryPrincipal {
  const admin = c.get('platformAdmin');
  return { issuer: 'platform-admin', subject: admin.id };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parsePreflight(value: unknown): RecoveryPreflight | null {
  const body = asBody(value);
  if (!body) return null;
  const keyVersions = body.keyVersions;
  if (!Array.isArray(keyVersions)) return null;
  const fields = [
    'schemaDigest', 'fieldInventoryDigest', 'backupGenerationId', 'stopPolicy',
    'rollbackPolicy', 'evidenceDigest', 'rowDigest',
  ];
  if (fields.some((field) => stringValue(body[field]) === null)) return null;
  const expectedRowCount = nonNegativeInteger(body.expectedRowCount);
  const expectedObjectCount = nonNegativeInteger(body.expectedObjectCount);
  const coverageTotal = nonNegativeInteger(body.coverageTotal);
  if (expectedRowCount === null || expectedObjectCount === null || coverageTotal === null) return null;
  const parsedKeyVersions = keyVersions.filter((item): item is string => typeof item === 'string');
  if (parsedKeyVersions.length !== keyVersions.length) return null;
  if (typeof body.coverageVerified !== 'boolean' || typeof body.keyRecoveryAcknowledged !== 'boolean') return null;
  return {
    schemaDigest: body.schemaDigest as string,
    fieldInventoryDigest: body.fieldInventoryDigest as string,
    keyVersions: parsedKeyVersions,
    backupGenerationId: body.backupGenerationId as string,
    expectedRowCount,
    expectedObjectCount,
    stopPolicy: body.stopPolicy as string,
    rollbackPolicy: body.rollbackPolicy as string,
    evidenceDigest: body.evidenceDigest as string,
    rowDigest: body.rowDigest as string,
    coverageTotal,
    coverageVerified: body.coverageVerified,
    keyRecoveryAcknowledged: body.keyRecoveryAcknowledged,
  };
}

function errorResponse(c: RecoveryContext, error: unknown) {
  const code = error instanceof RecoveryOperationError ? error.code : 'STORAGE_FAILED';
  const status: 400 | 404 | 409 | 500 = code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 409;
  return c.json({ success: false, error: code }, status);
}

async function audit(
  db: D1Database,
  adminId: string,
  operation: { id: string; scope: RecoveryScope; operation: RecoveryOperation },
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await recordPlatformAdminAccess(
    db,
    adminId,
    operation.scope.tenantId,
    action,
    'recovery_operation',
    operation.id,
    { operation: operation.operation, environment: operation.scope.environment, ...detail },
  );
}

function migrationApproval(operation: Awaited<ReturnType<typeof getRecoveryOperation>>): PatientIntakeMigrationApproval {
  if (!operation?.preflight || !operation.approverSubject) throw new RecoveryOperationError('PREFLIGHT_REQUIRED');
  return {
    approvedBy: operation.approverSubject,
    approvalReference: operation.id,
    coverageTotal: operation.preflight.expectedRowCount,
    coverageDigest: operation.preflight.rowDigest,
  };
}

function requirePhiKey(c: RecoveryContext): string | null {
  const value = c.env.PHARMACY_PHI_KEY_V1;
  if (!value || encoder.encode(value).length < 32 || value.length > 4096) {
    return null;
  }
  return value;
}

async function verifyIntakeCoverage(
  db: D1Database,
  operation: RecoveryOperation,
  scope: RecoveryScope,
  rootSecret: string,
  preflight: RecoveryPreflight,
): Promise<void> {
  const coverage = operation === 'fle_backfill'
    ? await inspectPatientIntakeBackfillCoverage(db, { ...scope, rootSecret })
    : await inspectPatientIntakeCoverage(db, { ...scope, rootSecret });
  const metadata = await patientIntakeRecoveryMetadata();
  if (coverage.errorCode || coverage.coverageTotal !== preflight.coverageTotal ||
      coverage.coverageTotal !== preflight.expectedRowCount ||
      coverage.coverageDigest !== preflight.rowDigest ||
      coverage.counts.covered !== coverage.counts.scanned ||
      preflight.schemaDigest !== metadata.schemaDigest ||
      preflight.fieldInventoryDigest !== metadata.fieldInventoryDigest ||
      JSON.stringify(preflight.keyVersions) !== JSON.stringify(metadata.keyVersions) ||
      !preflight.coverageVerified || !preflight.keyRecoveryAcknowledged ||
      preflight.stopPolicy !== 'stop-on-drift' ||
      preflight.rollbackPolicy !== 'restore-verified-envelope') {
    throw new RecoveryOperationError('PREFLIGHT_BLOCKED');
  }
}

type IntakeExecutionResult = {
  counts: Record<string, number>;
  errorCode: string | null;
  nextCursor: string | null;
};

async function executeIntakeOperation(
  db: D1Database,
  operation: NonNullable<Awaited<ReturnType<typeof getRecoveryOperation>>>,
  rootSecret: string,
  body: Body,
): Promise<IntakeExecutionResult> {
  if (!operation.preflight) throw new RecoveryOperationError('PREFLIGHT_REQUIRED');
  const cursor = body.cursor === null || body.cursor === undefined
    ? operation.cursor
    : typeof body.cursor === 'string' ? body.cursor : undefined;
  const limit = body.limit === undefined ? MAX_BATCH : body.limit;
  if (cursor === undefined || typeof limit !== 'number' || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > MAX_BATCH) throw new RecoveryOperationError('INVALID_INPUT');
  const scope = {
    tenantId: operation.scope.tenantId,
    lineAccountId: operation.scope.lineAccountId,
    rootSecret,
  };
  if (operation.operation === 'fle_backfill') {
    return backfillPatientIntakeEnvelopes(db, {
      ...scope, cursor, limit, dryRun: false,
    });
  }
  const approval = migrationApproval(operation);
  if (operation.operation === 'plaintext_scrub') {
    if (operation.cursor === null && !body.resume) {
      const frozen = await freezePatientIntakeWrites(db, scope, approval);
      if (frozen.errorCode) throw new RecoveryOperationError('PREFLIGHT_BLOCKED');
    }
    return scrubPatientIntakeLegacyFields(db, { ...scope, cursor, limit, dryRun: false, approval });
  }
  if (operation.operation === 'plaintext_restore') {
    return restorePatientIntakeLegacyFields(db, { ...scope, cursor, limit, dryRun: false, approval });
  }
  throw new RecoveryOperationError('INVALID_INPUT');
}

async function executeRetentionOperation(
  c: RecoveryContext,
  execution: {
    operationId: string;
    executionId: string;
    fenceToken: string;
    executorSubject: string;
    tenantId: string;
    lineAccountId: string;
    environment: string;
  },
  limit: number,
) {
  const options = { execution, limit };
  const backfill = await backfillIncomingImageTracking(c.env.DB, options);
  const inventory = await reconcileIncomingImageInventory(c.env.DB, c.env.IMAGES, options);
  if (backfill.tracked > 0) throw new RecoveryOperationError('STALE');
  if (backfill.blocked > 0 || inventory.orphan > 0 || inventory.missing > 0 ||
      inventory.mismatch > 0 || inventory.unknown > 0) {
    throw new RecoveryOperationError('PREFLIGHT_BLOCKED');
  }
  const readiness = await incomingImageRetentionReadiness(c.env.DB, { execution });
  if (readiness.status === 'BLOCKED') {
    const blocked = { purged: 0, failed: 0, skipped: 0 };
    return {
      backfill,
      inventory,
      prescriptions: blocked,
      incoming: blocked,
      incomingReconcile: blocked,
      prescriptionReconcile: blocked,
      readiness,
    };
  }
  const prescriptions = await purgePrescriptionFilesPastRetention(c.env.DB, c.env.IMAGES, options);
  const incoming = await purgeTrackedIncomingImages(c.env.DB, c.env.IMAGES, options);
  const incomingReconcile = await reconcileIncomingImageDeletionOutcomes(
    c.env.DB, c.env.IMAGES, options,
  );
  const prescriptionReconcile = await reconcilePrescriptionDeletionIntents(
    c.env.DB, c.env.IMAGES, options,
  );
  return {
    backfill, inventory, prescriptions, incoming, incomingReconcile,
    prescriptionReconcile, readiness,
  };
}

platformAdminDataProtectionRoutes.post(`${RECOVERY_PATH}`, async (c) => {
  const admin = c.get('platformAdmin');
  if (!admin) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = asBody(await c.req.json().catch(() => null));
  if (!body || identitySpoofed(body)) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  const scope = scopeFromBody(body);
  const operation = operationValue(body.operation);
  const approvalExpiresAt = stringValue(body.approvalExpiresAt);
  const idempotencyKey = stringValue(body.idempotencyKey);
  if (!scope || !operation || !approvalExpiresAt || !idempotencyKey) {
    return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  }
  try {
    const record = await createRecoveryApproval(c.env.DB, {
      scope, operation, requestedBy: principal(c), approvalExpiresAt, idempotencyKey,
      jobId: stringValue(body.jobId) ?? undefined,
    });
    await audit(c.env.DB, admin.id, record, 'recovery_operation_created');
    return c.json({ success: true, data: record }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

platformAdminDataProtectionRoutes.post(`${RECOVERY_PATH}/:operationId/preflight`, async (c) => {
  const admin = c.get('platformAdmin');
  if (!admin) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = asBody(await c.req.json().catch(() => null));
  if (!body || identitySpoofed(body)) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  const operationId = c.req.param('operationId');
  const current = await getRecoveryOperation(c.env.DB, operationId).catch(() => null);
  if (!current) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  let preflight = parsePreflight(body.preflight ?? body);
  if (current.operation === 'retention_delete') {
    const submitted = asBody(body.preflight);
    const backupGenerationId = stringValue(body.backupGenerationId) ??
      stringValue(submitted?.backupGenerationId);
    if (!backupGenerationId) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
    try {
      preflight = await buildRetentionPreflight(c.env.DB, {
        scope: current.scope,
        backupGenerationId,
        operationCreatedAt: current.createdAt,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  }
  if (!preflight) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  const isIntakeOperation = current.operation === 'fle_backfill' ||
    current.operation === 'plaintext_scrub' || current.operation === 'plaintext_restore';
  const rootSecret = isIntakeOperation ? requirePhiKey(c) : null;
  if (isIntakeOperation && !rootSecret) {
    return c.json({ success: false, error: 'Patient intake encryption is not configured' }, 503);
  }
  try {
    if (rootSecret) await verifyIntakeCoverage(c.env.DB, current.operation, current.scope, rootSecret, preflight);
    const record = await preflightRecoveryOperation(c.env.DB, {
      operationId,
      scope: current.scope,
      operation: current.operation,
      preflight,
    });
    await audit(c.env.DB, admin.id, record, 'recovery_operation_preflighted');
    return c.json({ success: true, data: record });
  } catch (error) {
    return errorResponse(c, error);
  }
});

platformAdminDataProtectionRoutes.post(`${RECOVERY_PATH}/:operationId/approve`, async (c) => {
  const admin = c.get('platformAdmin');
  if (!admin) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = asBody(await c.req.json().catch(() => null));
  if (body && identitySpoofed(body)) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  const operationId = c.req.param('operationId');
  const current = await getRecoveryOperation(c.env.DB, operationId).catch(() => null);
  if (!current) return c.json({ success: false, error: 'Not found' }, 404);
  try {
    const record = await approveRecoveryOperation(c.env.DB, {
      operationId, scope: current.scope, operation: current.operation, principal: principal(c),
    });
    await audit(c.env.DB, admin.id, record, 'recovery_operation_approved');
    return c.json({ success: true, data: record });
  } catch (error) {
    return errorResponse(c, error);
  }
});

platformAdminDataProtectionRoutes.post(`${RECOVERY_PATH}/:operationId/execute`, async (c) => {
  const admin = c.get('platformAdmin');
  if (!admin) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = asBody(await c.req.json().catch(() => null));
  if (!body || identitySpoofed(body)) return c.json({ success: false, error: 'Invalid recovery request' }, 400);
  const operationId = c.req.param('operationId');
  const current = await getRecoveryOperation(c.env.DB, operationId).catch(() => null);
  if (!current) return c.json({ success: false, error: 'Not found' }, 404);
  const isIntakeOperation = current.operation === 'fle_backfill' ||
    current.operation === 'plaintext_scrub' || current.operation === 'plaintext_restore';
  if (!isIntakeOperation && current.operation !== 'retention_delete') {
    return c.json({ success: false, error: 'Operation is not executable by this route' }, 409);
  }
  if (body.dryRun !== false) {
    return c.json({ success: false, error: 'Execute requires dryRun=false' }, 400);
  }
  let preflight = isIntakeOperation ? parsePreflight(body.preflight) : current.preflight;
  if (current.operation === 'retention_delete' && current.preflight && current.status !== 'running') {
    try {
      preflight = await buildRetentionPreflight(c.env.DB, {
        scope: current.scope,
        backupGenerationId: current.preflight.backupGenerationId,
        operationCreatedAt: current.createdAt,
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  }
  if (!preflight) return errorResponse(c, new RecoveryOperationError('PREFLIGHT_REQUIRED'));
  const rootSecret = isIntakeOperation ? requirePhiKey(c) : null;
  if (isIntakeOperation && !rootSecret) {
    return c.json({ success: false, error: 'Patient intake encryption is not configured' }, 503);
  }
  try {
    let claimed = current;
    if (current.status === 'running') {
      if (current.executorSubject !== admin.id || !current.executionId || !current.fenceToken) {
        throw new RecoveryOperationError('CLAIM_CONFLICT');
      }
    } else {
      claimed = await claimRecoveryOperation(c.env.DB, {
        operationId, scope: current.scope, operation: current.operation, executor: principal(c),
      });
    }
    const verified = await preflightRecoveryOperation(c.env.DB, {
      operationId, scope: claimed.scope, operation: claimed.operation, preflight,
      executionId: claimed.executionId!, fenceToken: claimed.fenceToken!,
    });
    if (isIntakeOperation && rootSecret) {
      await verifyIntakeCoverage(c.env.DB, verified.operation, verified.scope, rootSecret, preflight);
    }
    const execution = {
      operationId: verified.id,
      operation: verified.operation,
      tenantId: verified.scope.tenantId,
      lineAccountId: verified.scope.lineAccountId,
      environment: verified.scope.environment,
      executionId: verified.executionId!,
      fenceToken: verified.fenceToken!,
      executorSubject: admin.id,
    } as const;
    await assertRecoveryExecution(c.env.DB, execution);
    if (verified.operation === 'retention_delete') {
      const limit = body.limit === undefined ? MAX_BATCH : body.limit;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
        throw new RecoveryOperationError('INVALID_INPUT');
      }
      const result = await executeRetentionOperation(c, execution, limit);
      const failed = result.prescriptions.failed + result.incoming.failed +
        result.incomingReconcile.failed + result.prescriptionReconcile.failed +
        result.inventory.unknown;
      const blocked = result.backfill.blocked + result.inventory.orphan +
        result.inventory.missing + result.inventory.mismatch +
        result.prescriptions.skipped + result.incoming.skipped +
        result.incomingReconcile.skipped + result.prescriptionReconcile.skipped +
        (result.readiness.status === 'BLOCKED' ? 1 : 0);
      const rowBatch = result.prescriptions.purged + result.prescriptions.failed +
        result.prescriptions.skipped;
      const objectBatch = result.incoming.purged + result.incoming.failed + result.incoming.skipped;
      const processedRowCount = Math.min(
        verified.preflight!.expectedRowCount, verified.processedRowCount + rowBatch,
      );
      const processedObjectCount = Math.min(
        verified.preflight!.expectedObjectCount, verified.processedObjectCount + objectBatch,
      );
      const progressed = result.readiness.status === 'READY'
        ? await markRecoveryProgress(c.env.DB, {
          ...execution,
          batchId: stringValue(body.batchId) ??
            `${verified.id}:${verified.processedRowCount}:${verified.processedObjectCount}`,
          cursor: null,
          processedRowCount,
          processedObjectCount,
        })
        : verified;
      const final = failed === 0 && blocked === 0 &&
        processedRowCount === verified.preflight!.expectedRowCount &&
        processedObjectCount === verified.preflight!.expectedObjectCount
        ? await completeRecoveryOperation(c.env.DB, execution)
        : progressed;
      await audit(c.env.DB, admin.id, final,
        failed === 0 && blocked === 0
          ? 'recovery_operation_completed' : 'recovery_operation_progressed', {
          prescriptionPurged: result.prescriptions.purged,
          incomingPurged: result.incoming.purged,
          failed,
          blocked,
          readiness: result.readiness.status,
          blockedReasons: result.readiness.blockedReasons,
        });
      return c.json({ success: true, data: { operation: final, result } });
    }
    const result = await executeIntakeOperation(c.env.DB, verified, rootSecret!, body);
    if (result.errorCode) {
      throw new RecoveryOperationError(
        ['COVERAGE_MISMATCH', 'MISMATCH', 'MIXED_SENTINEL', 'CORRUPT_ENVELOPE',
          'PARTIAL_ENVELOPE', 'INVALID_STATE'].includes(result.errorCode)
          ? 'STALE' : 'STATE_CONFLICT',
      );
    }
    const batchId = stringValue(body.batchId) ?? `${verified.id}:${verified.cursor ?? 'start'}`;
    const progressed = await markRecoveryProgress(c.env.DB, {
      ...execution,
      batchId,
      cursor: result.nextCursor,
      processedRowCount: verified.processedRowCount + (result.counts.scanned ?? 0),
      processedObjectCount: verified.processedObjectCount,
    });
    const final = result.nextCursor === null
      ? await completeRecoveryOperation(c.env.DB, execution)
      : progressed;
    await audit(c.env.DB, admin.id, final, result.nextCursor === null
      ? 'recovery_operation_completed' : 'recovery_operation_progressed', {
      scanned: result.counts.scanned ?? 0,
      verified: result.counts.verified ?? 0,
    });
    return c.json({ success: true, data: { operation: final, result } });
  } catch (error) {
    if (error instanceof RecoveryOperationError &&
        ['PREFLIGHT_BLOCKED', 'STALE', 'EXECUTION_NOT_FOUND', 'FENCE_EXPIRED'].includes(error.code)) {
      const latest = await getRecoveryOperation(c.env.DB, operationId).catch(() => null);
      if (latest && latest.status === 'running' && latest.executorSubject === admin.id) {
        await markRecoveryStale(c.env.DB, {
          operationId, scope: latest.scope, operation: latest.operation, code: error.code,
        }).catch(() => undefined);
      }
    } else {
      const latest = await getRecoveryOperation(c.env.DB, operationId).catch(() => null);
      if (latest && latest.status === 'running' && latest.executorSubject === admin.id) {
        await markRecoveryFailed(c.env.DB, {
          operationId, scope: latest.scope, operation: latest.operation, code: 'EXECUTION_FAILED',
        }).catch(() => undefined);
      }
    }
    return errorResponse(c, error);
  }
});

platformAdminDataProtectionRoutes.get(`${RECOVERY_PATH}/:operationId`, async (c) => {
  const admin = c.get('platformAdmin');
  if (!admin) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const record = await getRecoveryOperation(c.env.DB, c.req.param('operationId')).catch(() => null);
  if (!record) return c.json({ success: false, error: 'Not found' }, 404);
  await audit(c.env.DB, admin.id, record, 'recovery_operation_viewed');
  return c.json({
    success: true,
    data: {
      ...record,
      readiness: record.operation === 'fle_backfill' || record.operation === 'plaintext_scrub' ||
        record.operation === 'plaintext_restore' ? 'UNVERIFIED' : 'NOT_RUN',
    },
  });
});
