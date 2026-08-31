import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, buildMigrationLedgerSql } from '../src/migrations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO, 'packages', 'db', 'migrations');
const MIGRATION_MANIFEST = [
  '001_v033_baseline.sql',
  '002_custom_060_messages_log_account_date.sql',
  '003_outbound_line_deliveries.sql',
  '004_custom_061_generic_resource_tenant_scope.sql',
  '005_custom_062_ref_tracking_tenant_scope.sql',
  '006_custom_063_auth_disable_revocation.sql',
  '007_custom_064_legacy_access_grant_drain.sql',
  '008_custom_065_session_rotation_family.sql',
] as const;
const BASELINE = MIGRATION_MANIFEST[0];
const baseline = readFileSync(join(MIGRATIONS_DIR, BASELINE));
const creds = { accountId: 'test', apiToken: 'test' };

type SqliteExecutor = NonNullable<Parameters<typeof applyD1Migrations>[0]['execute']>;

function sqliteExecutor(db: Database.Database): SqliteExecutor {
  return (async (opts: { sql: string; params?: any[] }) => {
    const params = opts.params ?? [];
    if (opts.sql.includes(';')) {
      db.transaction(() => db.exec(opts.sql))();
      return { success: true, result: [{ success: true, results: [] }] };
    }
    const statement = db.prepare(opts.sql);
    if (statement.reader) {
      return {
        success: true,
        result: [{ success: true, results: statement.all(...params) }],
      };
    }
    statement.run(...params);
    return { success: true, result: [{ success: true, results: [] }] };
  }) as SqliteExecutor;
}

describe('v0.33 migration epoch', () => {
  it('ships one authoritative baseline followed by ordered additive migrations', () => {
    expect(
      readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort(),
    ).toEqual(MIGRATION_MANIFEST);
  });

  it('treats the full setup-created v0.33 checksum ledger as a no-op', async () => {
    const db = new Database(':memory:');
    const migrations = new Map(
      MIGRATION_MANIFEST.map((name) => [name, readFileSync(join(MIGRATIONS_DIR, name))]),
    );
    db.exec(baseline.toString('utf8'));
    db.exec(buildMigrationLedgerSql([...MIGRATION_MANIFEST], migrations));

    const results = await applyD1Migrations({
      creds,
      databaseId: 'local',
      names: [...MIGRATION_MANIFEST],
      migrations,
      requireChecksumLedger: true,
      execute: sqliteExecutor(db),
    });

    expect(results).toHaveLength(MIGRATION_MANIFEST.length);
    expect(results.every((result) => result.alreadyApplied)).toBe(true);
  });

  it('rejects a pre-v0.33 ledger instead of silently upgrading it', async () => {
    const db = new Database(':memory:');
    db.exec(baseline.toString('utf8'));
    db.exec(`CREATE TABLE _line_harness_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    INSERT INTO _line_harness_migrations VALUES
      ('070_update_history_release_evidence.sql', 'sha256:old', '2026-08-30');`);

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'local',
        names: [BASELINE],
        migrations: new Map([[BASELINE, baseline]]),
        requireChecksumLedger: true,
        execute: sqliteExecutor(db),
      }),
    ).rejects.toThrow(/wrong migration epoch/);
  });
});
