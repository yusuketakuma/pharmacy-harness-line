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
  it('adds scoped booking receipts without rewriting a previous-version raw receipt', () => {
    const db = new Database(':memory:');
    try {
      db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
      db.prepare(`INSERT INTO booking_idempotency_keys
        (key, line_account_id, friend_id, response_status, response_body, expires_at)
        VALUES ('shared', 'account-a', 'friend-a', 201, '{"booking_id":"old"}', '2099-01-01T00:00:00.000Z')`).run();
      db.exec(readFileSync(join(MIGRATIONS_DIR, '022_booking_idempotency_scoped.sql'), 'utf8'));
      db.prepare(`INSERT INTO booking_idempotency_scoped
        (line_account_id, friend_id, key, response_status, response_body, expires_at)
        VALUES (?, ?, 'shared', 201, ?, '2099-01-01T00:00:00.000Z')`)
        .run('account-a', 'friend-a', '{"booking_id":"new-a"}');
      db.prepare(`INSERT INTO booking_idempotency_scoped
        (line_account_id, friend_id, key, response_status, response_body, expires_at)
        VALUES (?, ?, 'shared', 201, ?, '2099-01-01T00:00:00.000Z')`)
        .run('account-b', 'friend-b', '{"booking_id":"new-b"}');
      expect(db.prepare(`SELECT response_body FROM booking_idempotency_keys WHERE key = 'shared'`).get())
        .toEqual({ response_body: '{"booking_id":"old"}' });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM booking_idempotency_scoped WHERE key = 'shared'`).get())
        .toEqual({ count: 2 });
      expect(() => db.prepare(`INSERT INTO booking_idempotency_scoped
        (line_account_id, friend_id, key, response_status, response_body, expires_at)
        VALUES ('account-a', 'friend-a', 'shared', 201, '{}', '2099-01-01T00:00:00.000Z')`).run())
        .toThrow();
    } finally {
      db.close();
    }
  });

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
      '013_custom_070_patient_proxy_lifecycle.sql',
      '014_custom_071_shared_pharmacy_auth.sql',
      '015_custom_072_pharmacy_beta_memberships.sql',
      '016_custom_073_pharmacy_medication_followup_closure.sql',
      '017_custom_074_pharmacy_followup_operations.sql',
      '018_custom_075_pharmacy_medication_followup_assignments.sql',
      '019_custom_076_pharmacy_followup_operations_scope.sql',
      '020_custom_077_pharmacy_beta_notification_bindings.sql',
      '021_calendar_bookings_overlap_index.sql',
      '022_booking_idempotency_scoped.sql',
    '023_meet_reminder_delivery_id.sql',
    '024_stripe_effect_completion.sql',
    '025_friend_link_scope_triggers.sql',
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
