import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-24T00:00:00.000Z';

describe('custom_057 pharmacy retention deletion intents', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(readFileSync(join(ROOT, 'migrations/custom_057_pharmacy_retention_deletion_intents.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'tenant-a', 'A', 'active', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', 1, ?, ?)`).run(NOW, NOW);
  });

  it('stores tri-state hold epochs and all persistent intent states without PHI columns', () => {
    db.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch, status, updated_at)
      VALUES ('tenant-a', 'account-a', 'friend-a', '*', 4, 'unknown', ?)`).run(NOW);
    db.prepare(`INSERT INTO pharmacy_retention_deletion_intents
      (id, operation_id, execution_id, fence_token, executor_subject, environment,
       tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
       resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision,
       hold_epoch, status, created_at, updated_at)
      VALUES ('intent-a', 'operation-a', 'execution-a', ?, 'executor-a', 'test',
       'tenant-a', 'account-a', 'friend-a', '*', 'prescription_file', 'file-a',
       'custom/pharmacy/prescriptions/file-a', ?, ?, 'ready', 2, 4, 'CLAIMED', ?, ?)`).run(
      'f'.repeat(32), 'a'.repeat(64), '2023-01-01T00:00:00.000Z', NOW, NOW,
    );

    const columns = (db.prepare('PRAGMA table_info(pharmacy_retention_deletion_intents)')
      .all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'operation_id', 'execution_id', 'fence_token', 'executor_subject', 'environment',
      'hold_epoch', 'age_reference_at', 'status',
    ]));
    expect(columns).not.toEqual(expect.arrayContaining(['patient_name', 'message_content']));
    expect(db.prepare(
      `SELECT status, epoch FROM pharmacy_retention_hold_epochs`,
    ).get()).toEqual({ status: 'unknown', epoch: 4 });
  });

  it('enforces tenant/account ownership on the retention fence and intent', () => {
    expect(() => db.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, status, updated_at)
      VALUES ('other-tenant', 'account-a', 'friend-a', '*', 'held', ?)`).run(NOW))
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`INSERT INTO pharmacy_retention_deletion_intents
      (id, operation_id, execution_id, fence_token, executor_subject, environment,
       tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
       resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision,
       hold_epoch, status, created_at, updated_at)
      VALUES ('intent-cross', 'op', 'exec', ?, 'executor', 'test', 'other-tenant',
       'account-a', 'friend-a', '*', 'prescription_file', 'file', 'key', ?, ?,
       'ready', 1, 0, 'CLAIMED', ?, ?)`).run(
      'f'.repeat(32), 'a'.repeat(64), NOW, NOW, NOW,
    )).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('allows a newly approved operation to reconsider a previously cancelled resource', () => {
    const insert = db.prepare(`INSERT INTO pharmacy_retention_deletion_intents
      (id, operation_id, execution_id, fence_token, executor_subject, environment,
       tenant_id, line_account_id, owner_friend_id, patient_key, resource_type,
       resource_id, r2_key, stored_sha256, age_reference_at, row_state, row_revision,
       hold_epoch, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'executor-a', 'test', 'tenant-a', 'account-a', 'friend-a', '*',
       'prescription_file', 'file-a', 'key-a', ?, ?, 'ready', 1, 1, ?, ?, ?)`);
    insert.run(
      'intent-a', 'operation-a', 'execution-a', 'a'.repeat(32), 'a'.repeat(64),
      '2023-01-01T00:00:00.000Z', 'CANCELLED_HELD', NOW, NOW,
    );

    expect(() => insert.run(
      'intent-b', 'operation-b', 'execution-b', 'b'.repeat(32), 'a'.repeat(64),
      '2023-01-01T00:00:00.000Z', 'CLAIMED', NOW, NOW,
    )).not.toThrow();
    expect(() => insert.run(
      'intent-duplicate', 'operation-b', 'execution-other', 'c'.repeat(32), 'a'.repeat(64),
      '2023-01-01T00:00:00.000Z', 'CLAIMED', NOW, NOW,
    )).toThrow(/UNIQUE constraint failed/i);
  });
});
