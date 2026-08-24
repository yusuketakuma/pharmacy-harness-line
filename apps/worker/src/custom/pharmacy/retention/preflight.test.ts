import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildRetentionPreflight } from './preflight.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as new (filename: string) => {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): { changes: number };
  };
};

function d1From(sqlite: InstanceType<typeof Sqlite>): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {},
    }) as D1Result<T>,
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

const scope = { tenantId: 'tenant-a', lineAccountId: 'account-a', environment: 'test' };
const createdAt = '2026-08-24T00:00:00.000Z';

describe('retention recovery preflight', () => {
  let sqlite: InstanceType<typeof Sqlite>;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', ?, ?)`).run(createdAt, createdAt);
    sqlite.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'A', 'active', ?, ?)`).run(createdAt, createdAt);
    sqlite.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(createdAt, createdAt);
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', 1, ?, ?)`).run(createdAt, createdAt);
    sqlite.prepare(`INSERT INTO pharmacy_recovery_backup_generations
      (generation_id, tenant_id, line_account_id, environment, status, manifest_digest,
       expected_row_count, expected_object_count, verified_at, created_at)
      VALUES ('backup-a', 'tenant-a', 'account-a', 'test', 'verified', ?, 100, 3, ?, ?)`).run(
      'a'.repeat(64), createdAt, createdAt,
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, active_revision,
       upload_revision, created_at, updated_at)
      VALUES ('submission-a', 'account-a', 'friend-a', 'idem-a', 'closed', 1, 1, ?, ?)`).run(
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_files
      (id, submission_id, revision, position, r2_key, content_type, byte_size, sha256,
       state, created_at, updated_at)
      VALUES ('file-a', 'submission-a', 1, 1, 'custom/pharmacy/prescriptions/a',
       'image/jpeg', 1, ?, 'ready', ?, ?)`).run(
      'b'.repeat(64), '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
    );
    sqlite.prepare(`INSERT INTO pharmacy_incoming_image_objects
      (r2_key, tenant_id, line_account_id, message_id, stored_at)
      VALUES ('tenants/tenant-a/accounts/account-a/incoming/message-a.jpg',
       'tenant-a', 'account-a', 'message-a', '2020-01-01T00:00:00.000Z')`).run();
    db = d1From(sqlite);
  });

  it('derives a scope-bound, drift-sensitive preflight from the verified backup and live inventory', async () => {
    sqlite.prepare(`INSERT INTO pharmacy_incoming_image_objects
      (r2_key, tenant_id, line_account_id, message_id, stored_at)
      VALUES ('tenants/tenant-a/accounts/account-a/incoming/recent.jpg',
       'tenant-a', 'account-a', 'message-recent', '2026-08-23T00:00:00.000Z')`).run();
    const first = await buildRetentionPreflight(db, {
      scope, backupGenerationId: 'backup-a', operationCreatedAt: createdAt,
    });
    expect(first).toMatchObject({
      backupGenerationId: 'backup-a', expectedRowCount: 1, expectedObjectCount: 1,
      keyVersions: ['none'], coverageTotal: 2, coverageVerified: true,
      keyRecoveryAcknowledged: true, stopPolicy: 'stop-on-drift',
      rollbackPolicy: 'reconcile-only-no-blind-retry',
    });
    for (const digest of [
      first.schemaDigest, first.fieldInventoryDigest, first.evidenceDigest, first.rowDigest,
    ]) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.evidenceDigest).toBe('a'.repeat(64));

    sqlite.prepare(`UPDATE pharmacy_prescription_files SET revision = 2 WHERE id = 'file-a'`).run();
    const drifted = await buildRetentionPreflight(db, {
      scope, backupGenerationId: 'backup-a', operationCreatedAt: createdAt,
    });
    expect(drifted.rowDigest).not.toBe(first.rowDigest);
  });
});
