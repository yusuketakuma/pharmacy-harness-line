import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-20T00:00:00.000Z';

describe('custom_041 pharmacy patient intake migration state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    for (const suffix of ['a', 'b']) {
      db.prepare(`INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        `account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, NOW, NOW,
      );
      db.prepare(`INSERT INTO tenants
        (id, tenant_code, display_name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, suffix, suffix, NOW, NOW);
      db.prepare(`INSERT INTO tenant_line_accounts
        (tenant_id, line_account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, NOW, NOW);
    }
  });

  it('stores one approved migration state per mapped account', () => {
    db.prepare(`INSERT INTO pharmacy_patient_intake_migration_state
      (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
       approved_by, approval_reference, approved_at, updated_at)
      VALUES (?, ?, 'frozen', 3, ?, ?, ?, ?, ?)`).run(
      'tenant-a', 'account-a', 'a'.repeat(64), 'security-owner', 'TICKET-123', NOW, NOW,
    );
    expect(db.prepare(`SELECT phase, coverage_total FROM pharmacy_patient_intake_migration_state
      WHERE line_account_id = 'account-a'`).get()).toEqual({ phase: 'frozen', coverage_total: 3 });
    db.prepare(`UPDATE pharmacy_patient_intake_migration_state SET phase = 'restored'
      WHERE line_account_id = 'account-a'`).run();
    expect(db.prepare(`SELECT phase FROM pharmacy_patient_intake_migration_state
      WHERE line_account_id = 'account-a'`).get()).toEqual({ phase: 'restored' });
    expect(() => db.prepare(`INSERT INTO pharmacy_patient_intake_migration_state
      (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
       approved_by, approval_reference, approved_at, updated_at)
      VALUES (?, ?, 'frozen', 3, ?, ?, ?, ?, ?)`).run(
      'tenant-a', 'account-a', 'b'.repeat(64), 'other-owner', 'TICKET-456', NOW, NOW,
    )).toThrow(/unique/i);
  });

  it('rejects cross-tenant, invalid phase, and incomplete approval evidence', () => {
    const insert = (tenantId: string, phase: string, digest: string, approver: string) =>
      db.prepare(`INSERT INTO pharmacy_patient_intake_migration_state
        (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
         approved_by, approval_reference, approved_at, updated_at)
        VALUES (?, 'account-a', ?, 0, ?, ?, 'TICKET-123', ?, ?)`).run(
        tenantId, phase, digest, approver, NOW, NOW,
      );
    expect(() => insert('tenant-b', 'frozen', 'a'.repeat(64), 'owner')).toThrow(/foreign key/i);
    expect(() => insert('tenant-a', 'unknown', 'a'.repeat(64), 'owner')).toThrow(/check/i);
    expect(() => insert('tenant-a', 'frozen', 'short', 'owner')).toThrow(/check/i);
    expect(() => insert('tenant-a', 'frozen', 'a'.repeat(64), '')).toThrow(/check/i);
  });
});
