import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRecoveryApproval, assertRecoveryExecution, claimRecoveryOperation,
  completeRecoveryOperation, getRecoveryOperation, preflightRecoveryOperation, approveRecoveryOperation,
  markRecoveryProgress,
  type RecoveryPreflight, type RecoveryPrincipal, type RecoveryScope } from './operations.js';

const require = createRequire(import.meta.url);
const Sqlite = require(join(
  dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db/node_modules/better-sqlite3',
)) as new (filename: string) => {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): { get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[]; run(...values: unknown[]): { changes: number } };
};
const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const NOW = '2026-08-24T00:00:00.000Z';

function d1From(sqlite: InstanceType<typeof Sqlite>): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    __sql: sql,
    __values: values,
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => sqlite.prepare(sql).get(...values) as T | undefined ?? null,
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: Array<{ meta: { changes: number } }> = [];
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements as unknown as Array<{ __sql?: string; __values?: unknown[] }>) {
          if (!statement.__sql) throw new Error('test adapter statement missing SQL');
          results.push({
            meta: { changes: sqlite.prepare(statement.__sql).run(...(statement.__values ?? [])).changes },
          });
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function seed(): { db: D1Database; sqlite: InstanceType<typeof Sqlite> } {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES ('tenant-a', 'a', 'A', 'active', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'A', 'token', 'secret', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES ('tenant-a', 'account-a', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO pharmacy_recovery_backup_generations
    (generation_id, tenant_id, line_account_id, environment, status, manifest_digest,
     expected_row_count, expected_object_count, verified_at, created_at)
    VALUES ('backup-a', 'tenant-a', 'account-a', 'test', 'verified', ?, 1, 0, ?, ?)`).run(
    'a'.repeat(64), NOW, NOW,
  );
  return { db: d1From(sqlite), sqlite };
}

const scope: RecoveryScope = {
  tenantId: 'tenant-a', lineAccountId: 'account-a', environment: 'test',
};
const approver: RecoveryPrincipal = { issuer: 'platform-admin', subject: 'admin-a' };
const executor: RecoveryPrincipal = { issuer: 'platform-admin', subject: 'admin-b' };
const preflight: RecoveryPreflight = {
  schemaDigest: 'b'.repeat(64),
  fieldInventoryDigest: 'c'.repeat(64),
  keyVersions: ['1'],
  backupGenerationId: 'backup-a',
  expectedRowCount: 1,
  expectedObjectCount: 0,
  stopPolicy: 'stop-on-drift',
  rollbackPolicy: 'restore-verified-envelope',
  evidenceDigest: 'a'.repeat(64),
  rowDigest: 'e'.repeat(64),
  coverageTotal: 1,
  coverageVerified: true,
  keyRecoveryAcknowledged: true,
};

describe('pharmacy recovery operation state machine', () => {
  it('requires a verified preflight, independent executor, and one CAS claim', async () => {
    const { db } = seed();
    const created = await createRecoveryApproval(db, {
      scope, operation: 'plaintext_scrub', requestedBy: approver,
      approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'recovery-a',
    });
    await expect(preflightRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', preflight,
    })).resolves.toMatchObject({ status: 'preflighted' });
    await expect(approveRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', principal: approver,
    })).resolves.toMatchObject({ status: 'approved', approverSubject: 'admin-a' });
    await expect(claimRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', executor,
    })).resolves.toMatchObject({ status: 'running', executorSubject: 'admin-b' });
    await expect(claimRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', executor,
    })).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' });
    await expect(assertRecoveryExecution(db, {
      operation: 'plaintext_scrub', operationId: created.id, executionId: created.id,
      fenceToken: 'w'.repeat(32), executorSubject: 'admin-b', ...scope,
    })).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
  });

  it('returns a safe validation code for malformed execution proof values', async () => {
    const { db } = seed();
    await expect(assertRecoveryExecution(db, {
      operation: 'retention_delete', operationId: 'operation-a', executionId: 'execution-a',
      fenceToken: 7 as unknown as string, executorSubject: 'admin-b', ...scope,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps cursor resume bound to the same execution fence and completes once', async () => {
    const { db } = seed();
    const created = await createRecoveryApproval(db, {
      scope, operation: 'plaintext_scrub', requestedBy: approver,
      approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'recovery-resume',
    });
    await preflightRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', preflight,
    });
    await approveRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', principal: approver,
    });
    const claimed = await claimRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', executor,
    });
    const execution = {
      operation: 'plaintext_scrub' as const,
      operationId: claimed.id,
      executionId: claimed.executionId!,
      fenceToken: claimed.fenceToken!,
      executorSubject: executor.subject,
      ...scope,
    };
    await expect(markRecoveryProgress(db, {
      ...execution, batchId: 'batch-a', cursor: 'cursor-a',
      processedRowCount: 1, processedObjectCount: 0,
    })).resolves.toMatchObject({ cursor: 'cursor-a', lastBatchId: 'batch-a' });
    await expect(markRecoveryProgress(db, {
      ...execution, batchId: 'batch-a', cursor: 'cursor-a',
      processedRowCount: 1, processedObjectCount: 0,
    })).resolves.toMatchObject({ cursor: 'cursor-a', lastBatchId: 'batch-a' });
    await expect(markRecoveryProgress(db, {
      ...execution, fenceToken: 'x'.repeat(32), batchId: 'batch-b', cursor: 'cursor-b',
      processedRowCount: 2, processedObjectCount: 0,
    })).rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
    await expect(completeRecoveryOperation(db, execution))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(assertRecoveryExecution(db, execution))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
  });

  it('rejects an executor that is the authenticated approver principal', async () => {
    const { db } = seed();
    const created = await createRecoveryApproval(db, {
      scope, operation: 'plaintext_scrub', requestedBy: approver,
      approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'recovery-same-principal',
    });
    await preflightRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', preflight,
    });
    await approveRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', principal: approver,
    });
    await expect(claimRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', executor: approver,
    })).rejects.toMatchObject({ code: 'CLAIM_CONFLICT' });
  });

  it('rejects an already-expired approval before creating durable state', async () => {
    const { db, sqlite } = seed();
    await expect(createRecoveryApproval(db, {
      scope, operation: 'retention_delete', requestedBy: approver,
      approvalExpiresAt: new Date(Date.now() - 1000).toISOString(),
      idempotencyKey: 'recovery-expired',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_recovery_operations').get() as { count: number }).count)
      .toBe(0);
  });

  it('marks the execution stale when the backup manifest digest drifts at the same counts', async () => {
    const { db, sqlite } = seed();
    const created = await createRecoveryApproval(db, {
      scope, operation: 'plaintext_scrub', requestedBy: approver,
      approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'recovery-backup-drift',
    });
    await preflightRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', preflight,
    });
    await approveRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', principal: approver,
    });
    const claimed = await claimRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', executor,
    });
    sqlite.prepare(`UPDATE pharmacy_recovery_backup_generations
      SET manifest_digest = ? WHERE generation_id = 'backup-a' AND environment = 'test'`)
      .run('f'.repeat(64));

    await expect(preflightRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'plaintext_scrub', preflight,
      executionId: claimed.executionId!, fenceToken: claimed.fenceToken!,
    })).rejects.toMatchObject({ code: 'PREFLIGHT_BLOCKED' });
    await expect(getRecoveryOperation(db, created.id)).resolves.toMatchObject({ status: 'stale' });
    expect((sqlite.prepare(`SELECT status FROM pharmacy_recovery_execution_fences
      WHERE operation_id = ?`).get(created.id) as { status: string }).status).toBe('released');
  });

  it('exposes the same execution proof contract for retention_delete', async () => {
    const { db } = seed();
    const created = await createRecoveryApproval(db, {
      scope, operation: 'retention_delete', requestedBy: approver,
      approvalExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      idempotencyKey: 'retention-execution-contract',
    });
    await preflightRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'retention_delete', preflight,
    });
    await approveRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'retention_delete', principal: approver,
    });
    const claimed = await claimRecoveryOperation(db, {
      operationId: created.id, scope, operation: 'retention_delete', executor,
    });
    await expect(assertRecoveryExecution(db, {
      operation: 'retention_delete', operationId: claimed.id,
      executionId: claimed.executionId!, fenceToken: claimed.fenceToken!,
      executorSubject: executor.subject, ...scope,
    })).resolves.toMatchObject({ operation: { operation: 'retention_delete' }, fence: { status: 'active' } });
  });
});
