import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../index.js';

const recoveryMocks = vi.hoisted(() => {
  class MockRecoveryOperationError extends Error {
    constructor(public readonly code: string) {
      super(code);
      this.name = 'RecoveryOperationError';
    }
  }
  return {
    RecoveryOperationError: MockRecoveryOperationError,
    RECOVERY_ENVIRONMENT: 'current-worker-binding',
    RECOVERY_OPERATIONS: [
      'fle_backfill', 'plaintext_scrub', 'plaintext_restore',
      'retention_delete', 'restore_rehearsal',
    ],
    assertRecoveryExecution: vi.fn(),
    approveRecoveryOperation: vi.fn(),
    claimRecoveryOperation: vi.fn(),
    completeRecoveryOperation: vi.fn(),
    createRecoveryApproval: vi.fn(),
    getRecoveryOperation: vi.fn(),
    markRecoveryFailed: vi.fn(),
    markRecoveryProgress: vi.fn(),
    markRecoveryStale: vi.fn(),
    preflightRecoveryOperation: vi.fn(),
  };
});

const migrationMocks = vi.hoisted(() => ({
  backfillPatientIntakeEnvelopes: vi.fn(),
  freezePatientIntakeWrites: vi.fn(),
  inspectPatientIntakeBackfillCoverage: vi.fn(),
  inspectPatientIntakeCoverage: vi.fn(),
  patientIntakeRecoveryMetadata: vi.fn(),
  restorePatientIntakeLegacyFields: vi.fn(),
  scrubPatientIntakeLegacyFields: vi.fn(),
}));

const retentionMocks = vi.hoisted(() => ({
  backfillIncomingImageTracking: vi.fn(),
  buildRetentionPreflight: vi.fn(),
  incomingImageRetentionReadiness: vi.fn(),
  purgePrescriptionFilesPastRetention: vi.fn(),
  purgeTrackedIncomingImages: vi.fn(),
  reconcileIncomingImageDeletionOutcomes: vi.fn(),
  reconcileIncomingImageInventory: vi.fn(),
  reconcilePrescriptionDeletionIntents: vi.fn(),
}));

vi.mock('../recovery/operations.js', () => recoveryMocks);
vi.mock('../intake/migration.js', () => migrationMocks);
vi.mock('../retention/preflight.js', () => ({
  buildRetentionPreflight: retentionMocks.buildRetentionPreflight,
}));
vi.mock('../retention/incoming-images.js', () => ({
  backfillIncomingImageTracking: retentionMocks.backfillIncomingImageTracking,
  incomingImageRetentionReadiness: retentionMocks.incomingImageRetentionReadiness,
  purgeTrackedIncomingImages: retentionMocks.purgeTrackedIncomingImages,
  reconcileIncomingImageDeletionOutcomes: retentionMocks.reconcileIncomingImageDeletionOutcomes,
  reconcileIncomingImageInventory: retentionMocks.reconcileIncomingImageInventory,
}));
vi.mock('../prescriptions/retention-purge.js', () => ({
  purgePrescriptionFilesPastRetention: retentionMocks.purgePrescriptionFilesPastRetention,
  reconcilePrescriptionDeletionIntents: retentionMocks.reconcilePrescriptionDeletionIntents,
}));
vi.mock('./audit.js', () => ({
  recordPlatformAdminAccess: vi.fn(),
}));

import { platformAdminDataProtectionRoutes } from './data-protection-routes.js';

const scope = {
  tenantId: 'tenant-a', lineAccountId: 'account-a', environment: 'current-worker-binding',
};
const preflight = {
  schemaDigest: 'a'.repeat(64),
  fieldInventoryDigest: 'b'.repeat(64),
  keyVersions: ['1'],
  backupGenerationId: 'backup-a',
  expectedRowCount: 1,
  expectedObjectCount: 0,
  stopPolicy: 'stop-on-drift',
  rollbackPolicy: 'restore-verified-envelope',
  evidenceDigest: 'c'.repeat(64),
  rowDigest: 'd'.repeat(64),
  coverageTotal: 1,
  coverageVerified: true,
  keyRecoveryAcknowledged: true,
};
const retentionPreflight = {
  ...preflight,
  keyVersions: ['none'],
  expectedObjectCount: 1,
  stopPolicy: 'stop-on-drift',
  rollbackPolicy: 'reconcile-only-no-blind-retry',
  coverageTotal: 2,
};
const operation = {
  id: 'operation-a',
  scope,
  operation: 'plaintext_scrub' as const,
  status: 'approved' as const,
  requestedBySubject: 'admin-a',
  approverSubject: 'admin-a',
  executorSubject: null,
  approvalExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  jobId: 'job-a',
  idempotencyKey: 'idempotency-a',
  preflight,
  executionId: null,
  fenceId: null,
  fenceToken: null,
  cursor: null,
  processedRowCount: 0,
  processedObjectCount: 0,
  lastBatchId: null,
  errorCode: null,
  createdAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
  claimedAt: null,
  completedAt: null,
  updatedAt: new Date().toISOString(),
};

function app(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('platformAdmin', { id: 'admin-executor', name: 'Executor' });
    await next();
  });
  instance.route('/', platformAdminDataProtectionRoutes);
  return instance;
}

function env(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    API_KEY: 'api-key',
    PLATFORM_ADMIN_KEY: 'platform-key',
    CROSS_ACCOUNT_TOKEN_KEY: 'cross-account-key',
    LINE_CHANNEL_SECRET: 'line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.test',
    PHARMACY_PHI_KEY_V1: 'p'.repeat(32),
  };
}

const endpoint = '/api/platform-admin/data-protection/recovery-operations';

beforeEach(() => {
  vi.clearAllMocks();
  recoveryMocks.getRecoveryOperation.mockResolvedValue(operation);
  recoveryMocks.claimRecoveryOperation.mockResolvedValue({
    ...operation,
    status: 'running',
    executorSubject: 'admin-executor',
    executionId: 'execution-a',
    fenceId: 'fence-a',
    fenceToken: 'f'.repeat(32),
  });
  recoveryMocks.markRecoveryStale.mockResolvedValue(operation);
  recoveryMocks.markRecoveryFailed.mockResolvedValue(operation);
  migrationMocks.inspectPatientIntakeCoverage.mockResolvedValue({
    counts: { scanned: 1, covered: 1 },
    errorCode: null,
    coverageTotal: 1,
    coverageDigest: preflight.rowDigest,
  });
  migrationMocks.patientIntakeRecoveryMetadata.mockResolvedValue({
    schemaDigest: preflight.schemaDigest,
    fieldInventoryDigest: preflight.fieldInventoryDigest,
    keyVersions: preflight.keyVersions,
  });
  retentionMocks.buildRetentionPreflight.mockResolvedValue(retentionPreflight);
  retentionMocks.backfillIncomingImageTracking.mockResolvedValue({ tracked: 0, skipped: 0, blocked: 0 });
  retentionMocks.reconcileIncomingImageInventory.mockResolvedValue({
    orphan: 0, missing: 0, mismatch: 0, unknown: 0,
  });
  retentionMocks.purgePrescriptionFilesPastRetention.mockResolvedValue({ purged: 1, failed: 0, skipped: 0 });
  retentionMocks.purgeTrackedIncomingImages.mockResolvedValue({ purged: 1, failed: 0, skipped: 0 });
  retentionMocks.reconcileIncomingImageDeletionOutcomes.mockResolvedValue({
    purged: 0, failed: 0, skipped: 0,
  });
  retentionMocks.reconcilePrescriptionDeletionIntents.mockResolvedValue({ purged: 0, failed: 0, skipped: 0 });
  retentionMocks.incomingImageRetentionReadiness.mockResolvedValue({
    status: 'BLOCKED', blockedReasons: ['ec_sale_counter_audit_dependency_unresolved'],
    tracked: 1, dispositions: 1,
  });
});

describe('platform-admin data protection recovery routes', () => {
  it('rejects a client-supplied environment that is not the current Worker binding', async () => {
    const response = await app().request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        environment: 'production',
        operation: 'retention_delete',
        approvalExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        idempotencyKey: 'environment-spoof',
      }),
    }, env());

    expect(response.status).toBe(400);
    expect(recoveryMocks.createRecoveryApproval).not.toHaveBeenCalled();
  });

  it('rejects body identity spoofing before creating an approval', async () => {
    const response = await app().request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        operation: 'plaintext_scrub',
        approvalExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        idempotencyKey: 'request-a',
        approvedBy: 'attacker',
      }),
    }, env());

    expect(response.status).toBe(400);
    expect(recoveryMocks.createRecoveryApproval).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('attacker');
  });

  it('rejects body identity spoofing on approval and uses only the session principal', async () => {
    const response = await app().request(`${endpoint}/operation-a/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'attacker' }),
    }, env());

    expect(response.status).toBe(400);
    expect(recoveryMocks.approveRecoveryOperation).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('attacker');
  });

  it('does not claim or mutate when execute is not explicitly dryRun=false', async () => {
    const response = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, preflight }),
    }, env());

    expect(response.status).toBe(400);
    expect(recoveryMocks.claimRecoveryOperation).not.toHaveBeenCalled();
    expect(migrationMocks.scrubPatientIntakeLegacyFields).not.toHaveBeenCalled();
  });

  it('marks the claimed execution stale when the post-claim preflight drifts', async () => {
    recoveryMocks.getRecoveryOperation
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce({
        ...operation,
        status: 'running',
        executorSubject: 'admin-executor',
        executionId: 'execution-a',
        fenceId: 'fence-a',
        fenceToken: 'f'.repeat(32),
      });
    recoveryMocks.preflightRecoveryOperation.mockRejectedValue(
      new recoveryMocks.RecoveryOperationError('STALE'),
    );

    const response = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, preflight }),
    }, env());

    expect(response.status).toBe(409);
    expect(recoveryMocks.claimRecoveryOperation).toHaveBeenCalledOnce();
    expect(recoveryMocks.markRecoveryStale).toHaveBeenCalledWith(expect.anything(), {
      operationId: 'operation-a',
      scope,
      operation: 'plaintext_scrub',
      code: 'STALE',
    });
    expect(recoveryMocks.markRecoveryFailed).not.toHaveBeenCalled();
    expect(migrationMocks.scrubPatientIntakeLegacyFields).not.toHaveBeenCalled();
  });

  it('blocks an intake preflight when the server coverage digest is stale', async () => {
    recoveryMocks.getRecoveryOperation.mockResolvedValue({
      ...operation,
      status: 'created',
      approverSubject: null,
    });
    migrationMocks.inspectPatientIntakeCoverage.mockResolvedValue({
      counts: { scanned: 1, covered: 1 },
      errorCode: null,
      coverageTotal: 1,
      coverageDigest: 'e'.repeat(64),
    });

    const response = await app().request(`${endpoint}/operation-a/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preflight }),
    }, env());

    expect(response.status).toBe(409);
    expect(recoveryMocks.preflightRecoveryOperation).not.toHaveBeenCalled();
  });

  it('blocks a backfill preflight when its live inventory digest is client-stale', async () => {
    recoveryMocks.getRecoveryOperation.mockResolvedValue({
      ...operation,
      operation: 'fle_backfill',
      status: 'created',
      approverSubject: null,
    });
    migrationMocks.inspectPatientIntakeBackfillCoverage.mockResolvedValue({
      counts: { scanned: 1, covered: 1 },
      errorCode: null,
      coverageTotal: 1,
      coverageDigest: 'e'.repeat(64),
    });

    const response = await app().request(`${endpoint}/operation-a/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preflight }),
    }, env());

    expect(response.status).toBe(409);
    expect(recoveryMocks.preflightRecoveryOperation).not.toHaveBeenCalled();
  });

  it('does not treat arbitrary schema or field strings as an authoritative preflight', async () => {
    recoveryMocks.getRecoveryOperation.mockResolvedValue({
      ...operation,
      status: 'created',
      approverSubject: null,
    });
    const response = await app().request(`${endpoint}/operation-a/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        preflight: { ...preflight, schemaDigest: 'f'.repeat(64) },
      }),
    }, env());

    expect(response.status).toBe(409);
    expect(recoveryMocks.preflightRecoveryOperation).not.toHaveBeenCalled();
  });

  it('fails the operation when a migration batch reports an error', async () => {
    const claimed = {
      ...operation,
      status: 'running' as const,
      executorSubject: 'admin-executor',
      executionId: 'execution-a',
      fenceId: 'fence-a',
      fenceToken: 'f'.repeat(32),
    };
    recoveryMocks.getRecoveryOperation
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce(claimed);
    recoveryMocks.preflightRecoveryOperation.mockResolvedValue(claimed);
    recoveryMocks.assertRecoveryExecution.mockResolvedValue({ operation: claimed, fence: {} });
    migrationMocks.inspectPatientIntakeCoverage.mockResolvedValue({
      counts: { scanned: 1, covered: 1 },
      errorCode: null,
      coverageTotal: 1,
      coverageDigest: preflight.rowDigest,
    });
    migrationMocks.freezePatientIntakeWrites.mockResolvedValue({ errorCode: null });
    migrationMocks.scrubPatientIntakeLegacyFields.mockResolvedValue({
      counts: { scanned: 1, verified: 0 },
      errorCode: 'COVERAGE_MISMATCH',
      nextCursor: null,
    });

    const response = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, preflight }),
    }, env());

    expect(response.status).toBe(409);
    expect(recoveryMocks.markRecoveryStale).toHaveBeenCalledWith(expect.anything(), {
      operationId: 'operation-a',
      scope,
      operation: 'plaintext_scrub',
      code: 'STALE',
    });
    expect(recoveryMocks.markRecoveryProgress).not.toHaveBeenCalled();
    expect(recoveryMocks.completeRecoveryOperation).not.toHaveBeenCalled();
  });

  it('resumes a running batch for the same executor without claiming it again', async () => {
    const running = {
      ...operation,
      status: 'running' as const,
      executorSubject: 'admin-executor',
      executionId: 'execution-a',
      fenceId: 'fence-a',
      fenceToken: 'f'.repeat(32),
      cursor: 'cursor-a',
    };
    recoveryMocks.getRecoveryOperation.mockResolvedValue(running);
    recoveryMocks.markRecoveryProgress.mockResolvedValue({
      ...running, processedRowCount: 1, processedObjectCount: 0,
    });
    recoveryMocks.preflightRecoveryOperation.mockResolvedValue(running);
    recoveryMocks.assertRecoveryExecution.mockResolvedValue({ operation: running, fence: {} });
    recoveryMocks.markRecoveryProgress.mockResolvedValue(running);
    recoveryMocks.completeRecoveryOperation.mockResolvedValue({ ...running, status: 'completed' });
    migrationMocks.freezePatientIntakeWrites.mockResolvedValue({ errorCode: null });
    migrationMocks.scrubPatientIntakeLegacyFields.mockResolvedValue({
      counts: { scanned: 1, verified: 1 },
      errorCode: null,
      nextCursor: null,
    });

    const response = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, resume: true, preflight }),
    }, env());

    expect(response.status).toBe(200);
    expect(recoveryMocks.claimRecoveryOperation).not.toHaveBeenCalled();
    expect(migrationMocks.scrubPatientIntakeLegacyFields).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ cursor: 'cursor-a' }),
    );
  });

  it('blocks deletion until authoritative retention readiness is READY', async () => {
    const approved = { ...operation, operation: 'retention_delete' as const, preflight: retentionPreflight };
    const running = {
      ...approved,
      status: 'running' as const,
      executorSubject: 'admin-executor',
      executionId: 'execution-a',
      fenceId: 'fence-a',
      fenceToken: 'f'.repeat(32),
    };
    recoveryMocks.getRecoveryOperation.mockResolvedValue(approved);
    recoveryMocks.claimRecoveryOperation.mockResolvedValue(running);
    recoveryMocks.preflightRecoveryOperation.mockResolvedValue(running);
    recoveryMocks.assertRecoveryExecution.mockResolvedValue({ operation: running, fence: {} });
    recoveryMocks.completeRecoveryOperation.mockResolvedValue({ ...running, status: 'completed' });

    const response = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, limit: 10 }),
    }, env());

    expect(response.status).toBe(200);
    expect(retentionMocks.buildRetentionPreflight).toHaveBeenCalledWith(expect.anything(), {
      scope, backupGenerationId: 'backup-a', operationCreatedAt: operation.createdAt,
    });
    expect(retentionMocks.purgePrescriptionFilesPastRetention).not.toHaveBeenCalled();
    expect(retentionMocks.purgeTrackedIncomingImages).not.toHaveBeenCalled();
    expect(retentionMocks.reconcilePrescriptionDeletionIntents).not.toHaveBeenCalled();
    expect(recoveryMocks.completeRecoveryOperation).not.toHaveBeenCalled();
    const payload = await response.json() as { data: { operation: { status: string } } };
    expect(payload.data.operation.status).toBe('running');

    recoveryMocks.getRecoveryOperation.mockResolvedValue(running);
    retentionMocks.incomingImageRetentionReadiness.mockResolvedValue({
      status: 'READY', blockedReasons: [], tracked: 1, dispositions: 1,
    });
    const ready = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, resume: true, limit: 10 }),
    }, env());

    expect(ready.status).toBe(200);
    expect(retentionMocks.purgePrescriptionFilesPastRetention).toHaveBeenCalledOnce();
    expect(retentionMocks.purgeTrackedIncomingImages).toHaveBeenCalledOnce();
    expect(retentionMocks.reconcilePrescriptionDeletionIntents).toHaveBeenCalledOnce();
    expect(retentionMocks.reconcileIncomingImageDeletionOutcomes).toHaveBeenCalledOnce();
    expect(recoveryMocks.markRecoveryProgress).toHaveBeenCalledOnce();
    expect(recoveryMocks.completeRecoveryOperation).toHaveBeenCalledOnce();
    expect(retentionMocks.buildRetentionPreflight).toHaveBeenCalledOnce();
  });

  it('stales retention before deletion when backfill changes the approved inventory', async () => {
    const approved = { ...operation, operation: 'retention_delete' as const, preflight: retentionPreflight };
    const running = {
      ...approved,
      status: 'running' as const,
      executorSubject: 'admin-executor',
      executionId: 'execution-a',
      fenceId: 'fence-a',
      fenceToken: 'f'.repeat(32),
    };
    recoveryMocks.getRecoveryOperation.mockResolvedValue(approved);
    recoveryMocks.claimRecoveryOperation.mockResolvedValue(running);
    recoveryMocks.preflightRecoveryOperation.mockResolvedValue(running);
    recoveryMocks.assertRecoveryExecution.mockResolvedValue({ operation: running, fence: {} });
    retentionMocks.backfillIncomingImageTracking.mockResolvedValue({ tracked: 1, skipped: 0, blocked: 0 });
    retentionMocks.incomingImageRetentionReadiness.mockResolvedValue({
      status: 'READY', blockedReasons: [], tracked: 1, dispositions: 1,
    });

    const response = await app().request(`${endpoint}/operation-a/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, limit: 10 }),
    }, env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'STALE' });
    expect(retentionMocks.purgePrescriptionFilesPastRetention).not.toHaveBeenCalled();
    expect(retentionMocks.purgeTrackedIncomingImages).not.toHaveBeenCalled();
  });
});
