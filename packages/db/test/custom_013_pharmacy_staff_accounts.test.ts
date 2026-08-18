import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('custom_011 pharmacy staff account assignments', () => {
  it('creates an account-scoped assignment table with audit timestamps', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));

    const table = sqlite.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pharmacy_staff_accounts'`,
    ).get() as { sql: string } | undefined;
    expect(table?.sql).toContain('line_account_id');
    expect(table?.sql).toContain('staff_id');
    expect(table?.sql).toContain('created_at');
    expect(table?.sql).toContain('updated_at');

    const indexes = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_pharmacy_staff_accounts_staff'`,
    ).get() as { name: string } | undefined;
    expect(indexes?.name).toBe('idx_pharmacy_staff_accounts_staff');
  });

  it('can be applied repeatedly during an interrupted upgrade retry', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.exec('DROP TABLE pharmacy_staff_accounts');
    const migration = readFileSync(
      join(ROOT, 'migrations', 'custom_013_pharmacy_staff_accounts.sql'), 'utf8',
    );
    expect(() => sqlite.exec(migration)).not.toThrow();
    expect(() => sqlite.exec(migration)).not.toThrow();
  });
});
