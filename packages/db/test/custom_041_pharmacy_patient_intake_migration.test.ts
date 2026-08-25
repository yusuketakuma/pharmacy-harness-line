import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backfillPatientIntakeEnvelopes,
  freezePatientIntakeWrites,
  inspectPatientIntakeCoverage,
  restorePatientIntakeLegacyFields,
  scrubPatientIntakeLegacyFields,
  type PatientIntakeMigrationApproval,
} from '../../../apps/worker/src/custom/pharmacy/intake/migration.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-20T00:00:00.000Z';
const SECRET = 'synthetic-pharmacy-phi-root-secret-v1';
const SECRET_V2 = 'synthetic-pharmacy-phi-root-secret-v2';
const scope = { tenantId: 'tenant-a', lineAccountId: 'account-a', rootSecret: SECRET };
const approval: PatientIntakeMigrationApproval = {
  approvedBy: 'security-owner',
  approvalReference: 'FLE-5-TEST-001',
  coverageTotal: 3,
  coverageDigest: '',
};

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => {
    const parameters = values as never[];
    return ({
      bind: (...next: unknown[]) => statement(sql, next),
      first: async <T>() => (sqlite.prepare(sql).get(...parameters) as T | undefined) ?? null,
      all: async <T>() => ({
        success: true, results: sqlite.prepare(sql).all(...parameters) as T[], meta: {},
      }) as D1Result<T>,
      raw: async <T>() => sqlite.prepare(sql).all(...parameters) as T[],
      run: async () => statement(sql, values).runSync(),
      runSync: () => {
        const info = sqlite.prepare(sql).run(...parameters);
        return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
      },
    }) as unknown as RunnableStatement;
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>);
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function seedAccount(sqlite: Database.Database, suffix: 'a' | 'b'): void {
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, NOW, NOW,
  );
  sqlite.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, suffix, suffix, NOW, NOW);
  sqlite.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, NOW, NOW);
}

function seedResponse(
  sqlite: Database.Database,
  id: string,
  legacy: { snapshot: string; answers: string } = { snapshot: '{"name":"A"}', answers: '{"status":"ok"}' },
): void {
  sqlite.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, 'account-a', 1, ?, ?)`).run(`friend-${id}`, `U-${id}`, NOW, NOW);
  sqlite.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, 'account-a', ?, 'self', ?, ?, '1990-01-01', ?, ?)`).run(
    `patient-${id}`, `friend-${id}`, id, id, NOW, NOW,
  );
  sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
    (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
     patient_snapshot_json, answers_json, idempotency_key,
     representative_consent_at, privacy_consent_at, created_at)
    VALUES (?, 'account-a', ?, ?, 1, 2, ?, ?, ?, ?, ?, ?)`).run(
    id, `friend-${id}`, `patient-${id}`, legacy.snapshot, legacy.answers,
    `key-${id}`, NOW, NOW, NOW,
  );
}

function insertMigrationState(sqlite: Database.Database, digest: string, phase = 'frozen'): void {
  sqlite.prepare(`INSERT INTO pharmacy_patient_intake_migration_state
    (tenant_id, line_account_id, phase, coverage_total, coverage_digest,
     approved_by, approval_reference, approved_at, updated_at)
    VALUES ('tenant-a', 'account-a', ?, 3, ?, 'security-owner', 'FLE-5-TEST-001', ?, ?)`).run(
    phase, digest, NOW, NOW,
  );
}

describe('pharmacy patient intake bounded migration', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    seedAccount(sqlite, 'a');
    seedAccount(sqlite, 'b');
    seedResponse(sqlite, 'response-1');
    seedResponse(sqlite, 'response-2', { snapshot: '{"name":"B"}', answers: '{"status":"ready"}' });
    seedResponse(sqlite, 'response-3', { snapshot: '{"name":"C"}', answers: '{"status":"done"}' });
    db = d1From(sqlite);
  });

  it('defaults to dry-run, bounds at 50, and resumes with a PHI-free cursor report', async () => {
    const first = await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 2 });
    expect(first).toEqual({
      counts: { scanned: 2, verified: 2, inserted: 0, rewrapped: 0, skipped: 0, scrubbed: 0, restored: 0, conflicts: 0 },
      errorCode: null,
      nextCursor: 'response-2',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM pharmacy_patient_intake_envelopes').get())
      .toEqual({ count: 0 });
    expect(JSON.stringify(first)).not.toMatch(/patient-|\{"name"|status/);
    await expect(backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 51 }))
      .resolves.toMatchObject({ errorCode: 'INVALID_LIMIT', nextCursor: null });
  });

  it('inserts zero-envelope rows after encrypt/decrypt byte verification and skips two-envelope rows', async () => {
    const first = await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    expect(first).toMatchObject({ counts: { scanned: 3, verified: 3, inserted: 3 }, errorCode: null, nextCursor: null });
    const second = await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    expect(second).toMatchObject({ counts: { scanned: 3, verified: 3, inserted: 0, skipped: 3 }, errorCode: null });
  });

  it('rewraps scrubbed v1 envelopes to a separately rooted v2 key in bounded batches', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    sqlite.prepare(`UPDATE pharmacy_patient_intake_responses
      SET patient_snapshot_json = '{}', answers_json = '{}'`).run();
    const rotatedScope = {
      ...scope,
      rootSecretV2: SECRET_V2,
      activeKeyVersion: 2 as const,
    };

    const result = await backfillPatientIntakeEnvelopes(db, {
      ...rotatedScope, cursor: null, limit: 50, dryRun: false,
    });

    expect(result).toMatchObject({
      counts: { scanned: 3, verified: 3, inserted: 0, rewrapped: 3, conflicts: 0 },
      errorCode: null,
      nextCursor: null,
    });
    expect(sqlite.prepare(`SELECT key_version, COUNT(*) AS count
      FROM pharmacy_patient_intake_envelopes GROUP BY key_version`).all())
      .toEqual([{ key_version: 2, count: 6 }]);
    await expect(inspectPatientIntakeCoverage(db, rotatedScope)).resolves.toMatchObject({
      counts: { scanned: 3, covered: 3 }, errorCode: null,
      keyVersions: ['2'], keyVersionCounts: { '2': 6 },
    });
    await expect(inspectPatientIntakeCoverage(db, {
      ...rotatedScope, rootSecretV2: 'wrong-synthetic-pharmacy-phi-root-v2',
    })).resolves.toMatchObject({ errorCode: 'CORRUPT_ENVELOPE' });
  });

  it('leaves both fields on v1 when either envelope changes before the rewrap CAS', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    let raced = false;
    const racingDb = {
      ...db,
      prepare(sql: string) {
        const prepared = db.prepare(sql);
        if (!sql.includes('UPDATE pharmacy_patient_intake_envelopes\n    SET envelope_version')) {
          return prepared;
        }
        return {
          bind(...values: unknown[]) {
            const bound = prepared.bind(...values);
            return {
              ...bound,
              async run() {
                if (!raced) {
                  raced = true;
                  sqlite.prepare(`UPDATE pharmacy_patient_intake_envelopes
                    SET ciphertext = ?
                    WHERE response_id = 'response-1' AND field_name = 'patient_snapshot_json'`)
                    .run('B'.repeat(22));
                }
                return bound.run();
              },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database;

    const result = await backfillPatientIntakeEnvelopes(racingDb, {
      ...scope,
      rootSecretV2: SECRET_V2,
      activeKeyVersion: 2,
      cursor: null,
      limit: 1,
      dryRun: false,
    });

    expect(result).toMatchObject({
      counts: { rewrapped: 0, conflicts: 1 }, errorCode: 'CAS_CONFLICT',
    });
    expect(sqlite.prepare(`SELECT field_name, key_version
      FROM pharmacy_patient_intake_envelopes WHERE response_id = 'response-1'
      ORDER BY field_name`).all()).toEqual([
      { field_name: 'answers_json', key_version: 1 },
      { field_name: 'patient_snapshot_json', key_version: 1 },
    ]);
  });

  it('fails closed for partial, corrupt, mismatch, and CAS conflict without leaking row data', async () => {
    const initial = await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    expect(initial.errorCode).toBeNull();
    sqlite.prepare(`DELETE FROM pharmacy_patient_intake_envelopes
      WHERE response_id = 'response-1' AND field_name = 'answers_json'`).run();
    const partial = await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    expect(partial).toMatchObject({ errorCode: 'PARTIAL_ENVELOPE', nextCursor: null });

    sqlite.prepare(`UPDATE pharmacy_patient_intake_responses SET answers_json = '{"status":"tampered"}' WHERE id = 'response-2'`).run();
    const mismatch = await backfillPatientIntakeEnvelopes(db, {
      ...scope, cursor: 'response-1', limit: 50, dryRun: false,
    });
    expect(mismatch.errorCode).toBe('MISMATCH');
    expect(JSON.stringify(mismatch)).not.toMatch(/patient-|tampered/);
  });

  it('returns a deterministic coverage digest and requires matching named approval before scrub', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    const coverage = await inspectPatientIntakeCoverage(db, scope);
    expect(coverage).toMatchObject({ counts: { scanned: 3, covered: 3 }, errorCode: null, coverageTotal: 3 });
    expect(coverage.coverageDigest).toMatch(/^[0-9a-f]{64}$/);
    const stateApproval = { ...approval, coverageDigest: coverage.coverageDigest };
    insertMigrationState(sqlite, coverage.coverageDigest);

    const missingApproval = await scrubPatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 50, dryRun: false,
      approval: { ...stateApproval, approvedBy: '' },
    });
    expect(missingApproval.errorCode).toBe('APPROVAL_REQUIRED');
    expect(sqlite.prepare(`SELECT patient_snapshot_json, answers_json FROM pharmacy_patient_intake_responses WHERE id = 'response-1'`).get())
      .toEqual({ patient_snapshot_json: '{"name":"A"}', answers_json: '{"status":"ok"}' });
  });

  it('freezes writes only after coverage and named approval match', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    const coverage = await inspectPatientIntakeCoverage(db, scope);
    const approved = { ...approval, coverageDigest: coverage.coverageDigest };

    await expect(freezePatientIntakeWrites(db, scope, {
      ...approved, coverageDigest: 'a'.repeat(64),
    })).resolves.toMatchObject({ errorCode: 'COVERAGE_MISMATCH' });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM pharmacy_patient_intake_migration_state`).get())
      .toEqual({ count: 0 });

    await expect(freezePatientIntakeWrites(db, scope, approved))
      .resolves.toMatchObject({ errorCode: null, coverageTotal: 3 });
    expect(sqlite.prepare(`SELECT phase, approved_by, approval_reference
      FROM pharmacy_patient_intake_migration_state`).get()).toEqual({
      phase: 'frozen', approved_by: 'security-owner', approval_reference: 'FLE-5-TEST-001',
    });
  });

  it('lets a fresh scrub approval take over a partially scrubbed stale state', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    const coverage = await inspectPatientIntakeCoverage(db, scope);
    insertMigrationState(sqlite, coverage.coverageDigest, 'scrubbing');
    sqlite.prepare(`UPDATE pharmacy_patient_intake_responses
      SET patient_snapshot_json = '{}', answers_json = '{}'
      WHERE id = 'response-1'`).run();
    const takeoverApproval = {
      ...approval,
      approvedBy: 'security-owner-2',
      approvalReference: 'scrub-operation-2',
      coverageDigest: coverage.coverageDigest,
    };

    await expect(freezePatientIntakeWrites(db, scope, takeoverApproval))
      .resolves.toMatchObject({ errorCode: null, coverageTotal: 3 });
    expect(sqlite.prepare(`SELECT phase, approved_by, approval_reference
      FROM pharmacy_patient_intake_migration_state`).get()).toEqual({
      phase: 'frozen', approved_by: 'security-owner-2', approval_reference: 'scrub-operation-2',
    });

    await expect(scrubPatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 50, dryRun: false, approval: takeoverApproval,
    })).resolves.toMatchObject({ errorCode: null, nextCursor: null });
    expect(sqlite.prepare(`SELECT phase FROM pharmacy_patient_intake_migration_state`).get())
      .toEqual({ phase: 'scrubbed' });
  });

  it('scrubs both legacy fields atomically, supports resume, rejects mixed/sentinel tamper, and restores bytes', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    const coverage = await inspectPatientIntakeCoverage(db, scope);
    const stateApproval = { ...approval, coverageDigest: coverage.coverageDigest };
    insertMigrationState(sqlite, coverage.coverageDigest);

    const dryRun = await scrubPatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 1, approval: stateApproval,
    });
    expect(dryRun).toMatchObject({ counts: { scanned: 1, scrubbed: 0 }, errorCode: null, nextCursor: 'response-1' });
    expect(sqlite.prepare(`SELECT patient_snapshot_json FROM pharmacy_patient_intake_responses WHERE id = 'response-1'`).get())
      .toEqual({ patient_snapshot_json: '{"name":"A"}' });

    const first = await scrubPatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 2, dryRun: false, approval: stateApproval,
    });
    expect(first).toMatchObject({ counts: { scanned: 2, scrubbed: 2 }, errorCode: null, nextCursor: 'response-2' });
    const resumed = await scrubPatientIntakeLegacyFields(db, {
      ...scope, cursor: first.nextCursor, limit: 2, dryRun: false, approval: stateApproval,
    });
    expect(resumed).toMatchObject({ counts: { scanned: 1, scrubbed: 1 }, errorCode: null, nextCursor: null });
    expect(sqlite.prepare(`SELECT phase, patient_snapshot_json, answers_json
      FROM pharmacy_patient_intake_migration_state s
      JOIN pharmacy_patient_intake_responses r ON r.id = 'response-3'
      WHERE s.line_account_id = 'account-a'`).get()).toMatchObject({ phase: 'scrubbed' });
    expect(sqlite.prepare(`SELECT patient_snapshot_json, answers_json FROM pharmacy_patient_intake_responses`).all())
      .toEqual([
        { patient_snapshot_json: '{}', answers_json: '{}' },
        { patient_snapshot_json: '{}', answers_json: '{}' },
        { patient_snapshot_json: '{}', answers_json: '{}' },
      ]);

    sqlite.prepare(`UPDATE pharmacy_patient_intake_envelopes SET ciphertext = 'BBBBBBBBBBBBBBBBBBBBBB'
      WHERE response_id = 'response-1' AND field_name = 'answers_json'`).run();
    const tampered = await restorePatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 50, dryRun: false, approval: stateApproval,
    });
    expect(tampered.errorCode).toBe('CORRUPT_ENVELOPE');
    expect(sqlite.prepare(`SELECT patient_snapshot_json, answers_json FROM pharmacy_patient_intake_responses WHERE id = 'response-1'`).get())
      .toEqual({ patient_snapshot_json: '{}', answers_json: '{}' });
  });

  it('restores byte-identical fields and keeps writes frozen until the Worker rollback', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    const coverage = await inspectPatientIntakeCoverage(db, scope);
    const stateApproval = { ...approval, coverageDigest: coverage.coverageDigest };
    insertMigrationState(sqlite, coverage.coverageDigest, 'scrubbed');
    sqlite.prepare(`UPDATE pharmacy_patient_intake_responses SET patient_snapshot_json = '{}', answers_json = '{}'`).run();
    const result = await restorePatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 2, dryRun: false, approval: stateApproval,
    });
    expect(result).toMatchObject({ counts: { scanned: 2, restored: 2 }, errorCode: null, nextCursor: 'response-2' });
    const resumed = await restorePatientIntakeLegacyFields(db, {
      ...scope, cursor: result.nextCursor, limit: 2, dryRun: false, approval: stateApproval,
    });
    expect(resumed).toMatchObject({ counts: { scanned: 1, restored: 1 }, errorCode: null, nextCursor: null });
    expect(sqlite.prepare(`SELECT phase FROM pharmacy_patient_intake_migration_state`).get())
      .toEqual({ phase: 'restored' });
    expect(sqlite.prepare(`SELECT patient_snapshot_json, answers_json FROM pharmacy_patient_intake_responses ORDER BY id`).all())
      .toEqual([
        { patient_snapshot_json: '{"name":"A"}', answers_json: '{"status":"ok"}' },
        { patient_snapshot_json: '{"name":"B"}', answers_json: '{"status":"ready"}' },
        { patient_snapshot_json: '{"name":"C"}', answers_json: '{"status":"done"}' },
      ]);
  });

  it('binds a completed scrub to a separately approved restore operation', async () => {
    await backfillPatientIntakeEnvelopes(db, { ...scope, cursor: null, limit: 50, dryRun: false });
    const coverage = await inspectPatientIntakeCoverage(db, scope);
    insertMigrationState(sqlite, coverage.coverageDigest, 'scrubbed');
    sqlite.prepare(`UPDATE pharmacy_patient_intake_responses
      SET patient_snapshot_json = '{}', answers_json = '{}'`).run();
    const restoreApproval = {
      ...approval,
      approvedBy: 'restore-owner',
      approvalReference: 'restore-operation-1',
      coverageDigest: coverage.coverageDigest,
    };

    await expect(restorePatientIntakeLegacyFields(db, {
      ...scope, cursor: null, limit: 50, dryRun: false, approval: restoreApproval,
    })).resolves.toMatchObject({
      counts: { scanned: 3, restored: 3 }, errorCode: null, nextCursor: null,
    });
    expect(sqlite.prepare(`SELECT phase, approved_by, approval_reference
      FROM pharmacy_patient_intake_migration_state`).get()).toEqual({
      phase: 'restored', approved_by: 'restore-owner', approval_reference: 'restore-operation-1',
    });
  });
});
