import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_056 pharmacy recovery operations', () => {
  it('defines fixed-purpose, account/environment-scoped recovery state', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    const meta = JSON.parse(readFileSync(join(ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toEqual([
      '001_v033_baseline.sql',
      '002_custom_060_messages_log_account_date.sql',
      '003_outbound_line_deliveries.sql',
      '004_custom_061_generic_resource_tenant_scope.sql',
      '005_custom_062_ref_tracking_tenant_scope.sql',
      '006_custom_063_auth_disable_revocation.sql',
      '007_custom_064_legacy_access_grant_drain.sql',
      '008_custom_065_session_rotation_family.sql',
      '009_custom_066_auth_session_activity.sql',
      '010_custom_067_admin_login_throttles.sql',
    ]);

    const tableNames = db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'pharmacy_recovery_%'
      ORDER BY name`).all() as Array<{ name: string }>;
    expect(tableNames.map((row) => row.name)).toEqual([
      'pharmacy_recovery_backup_generations',
      'pharmacy_recovery_execution_fences',
      'pharmacy_recovery_operations',
    ]);

    const operationSql = db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'pharmacy_recovery_operations'`).get() as { sql: string };
    expect(operationSql.sql).toContain("'fle_backfill'");
    expect(operationSql.sql).toContain("'plaintext_scrub'");
    expect(operationSql.sql).toContain("'plaintext_restore'");
    expect(operationSql.sql).toContain("'retention_delete'");
    expect(operationSql.sql).toContain("'restore_rehearsal'");
    expect(operationSql.sql).toContain("'platform-admin'");
    expect(operationSql.sql).toContain('executor_subject <> approver_subject');
  });

  it('requires a verified backup generation in the exact tenant/account/environment scope', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    const now = '2026-08-24T00:00:00.000Z';
    db.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'a', 'A', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token', 'secret', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(now, now);

    db.prepare(`INSERT INTO pharmacy_recovery_backup_generations
      (generation_id, tenant_id, line_account_id, environment, status, manifest_digest,
       expected_row_count, expected_object_count, verified_at, created_at)
      VALUES ('backup-a', 'tenant-a', 'account-a', 'test', 'verified', ?, 1, 0, ?, ?)`).run(
      'a'.repeat(64), now, now,
    );
    expect(() => db.prepare(`INSERT INTO pharmacy_recovery_backup_generations
      (generation_id, tenant_id, line_account_id, environment, status, manifest_digest,
       expected_row_count, expected_object_count, verified_at, created_at)
      VALUES ('backup-a', 'tenant-a', 'account-a', 'production', 'verified', ?, 1, 0, ?, ?)`).run(
      'b'.repeat(64), now, now,
    )).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_recovery_backup_generations
      WHERE generation_id = 'backup-a' AND environment = 'test' AND status = 'verified'`).get())
      .toEqual({ count: 1 });

    db.prepare(`INSERT INTO pharmacy_recovery_operations
      (id, tenant_id, line_account_id, environment, operation, status,
       requested_by_issuer, requested_by_subject, approval_expires_at, job_id,
       idempotency_key, created_at, updated_at)
      VALUES ('operation-a', 'tenant-a', 'account-a', 'test', 'retention_delete',
        'approved', 'platform-admin', 'admin-a', ?, 'job-a', 'idempotency-a', ?, ?)`).run(
      '2026-08-25T00:00:00.000Z', now, now,
    );
    expect(() => db.prepare(`INSERT INTO pharmacy_recovery_execution_fences
      (fence_id, operation_id, tenant_id, line_account_id, environment,
       execution_id, fence_token, owner_issuer, owner_subject, status,
       expires_at, created_at)
      VALUES ('fence-a', 'operation-a', 'tenant-a', 'account-a', 'production',
        'execution-a', ?, 'platform-admin', 'admin-b', 'active', ?, ?)`).run(
      'f'.repeat(32), '2026-08-25T00:00:00.000Z', now,
    )).toThrow();
  });
});
