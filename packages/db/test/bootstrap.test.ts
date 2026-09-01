import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const GENERATOR = join(PKG_ROOT, 'scripts', 'generate-bootstrap.mjs');
const BOOTSTRAP_PATH = join(PKG_ROOT, 'bootstrap.sql');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BASELINE_MIGRATION = '001_v033_baseline.sql';
const MESSAGE_STATS_MIGRATION = '002_custom_060_messages_log_account_date.sql';
const OUTBOUND_DELIVERY_MIGRATION = '003_outbound_line_deliveries.sql';
const GENERIC_RESOURCE_SCOPE_MIGRATION = '004_custom_061_generic_resource_tenant_scope.sql';
const REF_TRACKING_SCOPE_MIGRATION = '005_custom_062_ref_tracking_tenant_scope.sql';
const AUTH_DISABLE_REVOCATION_MIGRATION = '006_custom_063_auth_disable_revocation.sql';
const LEGACY_GRANT_DRAIN_MIGRATION = '007_custom_064_legacy_access_grant_drain.sql';
const SESSION_ROTATION_FAMILY_MIGRATION = '008_custom_065_session_rotation_family.sql';
const AUTH_SESSION_ACTIVITY_MIGRATION = '009_custom_066_auth_session_activity.sql';
const ADMIN_LOGIN_THROTTLES_MIGRATION = '010_custom_067_admin_login_throttles.sql';
const PATIENT_PROXY_CONTROLS_MIGRATION = '011_custom_068_patient_proxy_controls.sql';
const PATIENT_CONTROL_AUDIT_MIGRATION = '012_custom_069_patient_control_audit.sql';

const BENIGN_SQLITE_ERROR = /duplicate column name|already exists/i;

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function applyMigrationReplay(db: Database.Database): void {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  db.exec(readFileSync(join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8'));

  for (const file of migrationFiles.filter((name) => name !== BASELINE_MIGRATION)) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitSqlStatements(sql)) {
      try {
        db.exec(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!BENIGN_SQLITE_ERROR.test(message)) {
          throw new Error(`${file}: ${message}`);
        }
      }
    }
  }
}

function readSchemaObjects(db: Database.Database) {
  return db
    .prepare(
      `
        SELECT type, name, sql
        FROM sqlite_master
        WHERE sql IS NOT NULL
          AND name NOT LIKE 'sqlite_%'
        ORDER BY
          CASE type
            WHEN 'table' THEN 0
            WHEN 'index' THEN 1
            WHEN 'trigger' THEN 2
            WHEN 'view' THEN 3
            ELSE 4
          END,
          name
      `,
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
}

describe('bootstrap.sql', () => {
  it('uses the v0.33 baseline followed by globally ordered additive migrations', () => {
    expect(
      readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.sql'))
        .sort(),
    ).toEqual([
      BASELINE_MIGRATION,
      MESSAGE_STATS_MIGRATION,
      OUTBOUND_DELIVERY_MIGRATION,
      GENERIC_RESOURCE_SCOPE_MIGRATION,
      REF_TRACKING_SCOPE_MIGRATION,
      AUTH_DISABLE_REVOCATION_MIGRATION,
      LEGACY_GRANT_DRAIN_MIGRATION,
      SESSION_ROTATION_FAMILY_MIGRATION,
      AUTH_SESSION_ACTIVITY_MIGRATION,
      ADMIN_LOGIN_THROTTLES_MIGRATION,
      PATIENT_PROXY_CONTROLS_MIGRATION,
      PATIENT_CONTROL_AUDIT_MIGRATION,
    ]);
  });

  it('uses the account/date index for bounded message statistics', () => {
    const db = new Database(':memory:');
    applyMigrationReplay(db);
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT COUNT(*) FROM messages_log
        WHERE line_account_id = ?
          AND julianday(CASE
                WHEN created_at GLOB '*Z' OR substr(created_at, -6, 1) IN ('+', '-')
                  THEN created_at
                ELSE created_at || '+09:00'
              END) >= julianday(?)
          AND julianday(CASE
                WHEN created_at GLOB '*Z' OR substr(created_at, -6, 1) IN ('+', '-')
                  THEN created_at
                ELSE created_at || '+09:00'
              END) < julianday(?)`,
    ).all('account-a', '2026-07-31T15:00:00.000Z', '2026-08-31T15:00:00.000Z') as Array<{
      detail: string;
    }>;
    expect(plan.map(({ detail }) => detail).join('\n'))
      .toContain('idx_messages_log_account_created_at');
  });

  it('requires every support grant to be bound to one platform-admin session', () => {
    const db = new Database(':memory:');
    applyMigrationReplay(db);
    const column = db.prepare(`PRAGMA table_info(platform_admin_access_grants)`).all()
      .find((row) => (row as { name: string }).name === 'session_token_hash') as { notnull: number };
    expect(column.notnull).toBe(1);
  });

  it(
    'stays in sync with schema.sql + post-baseline migrations',
    () => {
      expect(() =>
        execFileSync('node', [GENERATOR, '--check'], {
          cwd: PKG_ROOT,
          stdio: 'pipe',
        }),
      ).not.toThrow();
    },
    15000,
  );

  it('matches the schema produced by replaying all migrations', () => {
    const bootstrapDb = new Database(':memory:');
    const replayDb = new Database(':memory:');

    bootstrapDb.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
    applyMigrationReplay(replayDb);

    expect(readSchemaObjects(bootstrapDb)).toEqual(readSchemaObjects(replayDb));
  });

  it('includes built-in auto-reply seed data for clean installs', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));

    const rule = db
      .prepare(
        `SELECT keyword, match_type, response_type, line_account_id, is_active, response_content
           FROM auto_replies
          WHERE id = 'builtin-mileage-wallet-keyword'`,
      )
      .get() as {
        keyword: string;
        match_type: string;
        response_type: string;
        line_account_id: string | null;
        is_active: number;
        response_content: string;
      } | undefined;

    expect(rule).toMatchObject({
      keyword: 'マイル',
      match_type: 'exact',
      response_type: 'flex',
      line_account_id: null,
      is_active: 1,
    });
    expect(rule?.response_content).toContain('?page=affiliate&liffId={{liff_id}}');
  });

  it('includes deterministic built-in mileage seed data for clean installs', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));

    expect(
      db.prepare("SELECT code, name, status FROM mileage_programs WHERE id = 'default'").get(),
    ).toEqual({ code: 'default', name: 'Harnessマイル', status: 'active' });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM mileage_rules WHERE id LIKE 'builtin-%'").get(),
    ).toEqual({ count: 22 });
  });
});
