import {
  assertRecoveryExecution,
  type RecoveryExecution,
} from '../recovery/operations.js';

/** Execution proof required by every retention deletion mutation. */
export interface RetentionDeleteExecution {
  operationId: string;
  executionId: string;
  fenceToken: string;
  executorSubject: string;
  tenantId: string;
  lineAccountId: string;
  environment: string;
}

function safeExecutionValue(value: unknown, maximum: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertRetentionDeleteExecutionShape(
  value: unknown,
): asserts value is RetentionDeleteExecution {
  if (!value || typeof value !== 'object') {
    throw new Error('retention deletion execution proof is required');
  }
  const proof = value as Partial<RetentionDeleteExecution>;
  if (!safeExecutionValue(proof.operationId, 200) ||
      !safeExecutionValue(proof.executionId, 200) ||
      !safeExecutionValue(proof.fenceToken, 240) || proof.fenceToken.length < 32 ||
      !safeExecutionValue(proof.executorSubject, 200) ||
      !safeExecutionValue(proof.tenantId, 200) ||
      !safeExecutionValue(proof.lineAccountId, 200) ||
      !safeExecutionValue(proof.environment, 80)) {
    throw new Error('retention deletion execution proof is invalid');
  }
}

/**
 * The caller-supplied shape is not authority. This delegates to the recovery
 * operation/fence CAS so approval, scope, executor, execution and fence
 * freshness are checked against D1 immediately before any retention mutation.
 */
export async function assertRetentionDeleteExecution(
  db: D1Database,
  value: unknown,
): Promise<RetentionDeleteExecution> {
  assertRetentionDeleteExecutionShape(value);
  const execution: RecoveryExecution = {
    operation: 'retention_delete',
    operationId: value.operationId,
    executionId: value.executionId,
    fenceToken: value.fenceToken,
    executorSubject: value.executorSubject,
    tenantId: value.tenantId,
    lineAccountId: value.lineAccountId,
    environment: value.environment,
  };
  await assertRecoveryExecution(db, execution);
  return value;
}

export function executionMatchesScope(
  execution: RetentionDeleteExecution,
  tenantId: string | null,
  lineAccountId: string,
): boolean {
  return execution.tenantId === tenantId && execution.lineAccountId === lineAccountId;
}
