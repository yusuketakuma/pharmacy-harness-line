import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../test-sqlite.js';
import {
  openPatientIntakeField,
  sealPatientIntakeField,
} from './encryption.js';
import {
  openPatientIntakeFields,
  patientIntakeEncryptionContext,
  type PatientIntakeEncryptedRow,
} from './envelopes.js';
import {
  freezePatientIntakeWrites,
  inspectPatientIntakeCoverage,
  restorePatientIntakeLegacyFields,
  scrubPatientIntakeLegacyFields,
  type PatientIntakeMigrationApproval,
} from './migration.js';

const d1From = d1FromSqlite;
const NOW = '2026-09-15T00:00:00.000Z';
const SCOPE = { tenantId: 'tenant-a', lineAccountId: 'account-a' };
const CRYPTO = { ...SCOPE, rootSecret: 's'.repeat(32) };

function seedBase(): { db: D1Database; sqlite: InstanceType<typeof Sqlite> } {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES ('tenant-a', 'a', 'A', 'active', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'A', 'token', 'secret', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES ('tenant-a', 'account-a', ?, ?)`).run(NOW, NOW);
  sqlite.prepare(`INSERT INTO friends (id, line_user_id, line_account_id)
    VALUES ('friend-a', 'U-a', 'account-a')`).run();
  sqlite.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES ('patient-a', 'account-a', 'friend-a', 'self', 'Synthetic', 'サンセティック',
     '1990-01-01', ?, ?)`).run(NOW, NOW);
  return { db: d1From(sqlite), sqlite };
}

function seedResponse(
  sqlite: InstanceType<typeof Sqlite>,
  id: string,
  snapshot = '{"name":"synthetic"}',
  answers = '{"allergiesStatus":"none"}',
): PatientIntakeEncryptedRow {
  const revision = (sqlite.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS next
    FROM pharmacy_patient_intake_responses
    WHERE line_account_id = 'account-a' AND patient_id = 'patient-a'`)
    .get() as { next: number }).next;
  sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
    (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
     patient_snapshot_json, answers_json, idempotency_key,
     representative_consent_at, privacy_consent_at, created_at)
    VALUES (?, 'account-a', 'friend-a', 'patient-a', ?, 2, ?, ?, ?, ?, ?, ?)`)
    .run(id, revision, snapshot, answers, `idem-${id}`, NOW, NOW, NOW);
  return {
    id,
    line_account_id: 'account-a',
    owner_friend_id: 'friend-a',
    patient_id: 'patient-a',
    revision,
    schema_version: 2,
    patient_snapshot_json: snapshot,
    answers_json: answers,
  };
}

async function seedEnvelopes(
  sqlite: InstanceType<typeof Sqlite>,
  row: PatientIntakeEncryptedRow,
  snapshotPlaintext: string,
  answersPlaintext: string,
): Promise<void> {
  for (const [fieldName, plaintext] of [
    ['patient_snapshot_json', snapshotPlaintext],
    ['answers_json', answersPlaintext],
  ] as const) {
    const envelope = await sealPatientIntakeField(
      plaintext,
      CRYPTO.rootSecret,
      patientIntakeEncryptionContext(row, CRYPTO, fieldName),
    );
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_envelopes
      (response_id, tenant_id, line_account_id, owner_friend_id, patient_id, field_name,
       schema_version, source_revision, envelope_version, key_version, nonce,
       ciphertext, encrypted_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'patient-a', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, fieldName, row.schema_version, row.revision,
        envelope.envelopeVersion, envelope.keyVersion, envelope.nonce,
        envelope.ciphertext, NOW,
      );
  }
}

async function approvalFor(db: D1Database, approver: string): Promise<PatientIntakeMigrationApproval> {
  const coverage = await inspectPatientIntakeCoverage(db, CRYPTO);
  if (coverage.errorCode) throw new Error(`coverage failed: ${coverage.errorCode}`);
  return {
    approvedBy: approver,
    approvalReference: `op-${approver}`,
    coverageTotal: coverage.coverageTotal,
    coverageDigest: coverage.coverageDigest,
  };
}

function migrationState(sqlite: InstanceType<typeof Sqlite>) {
  return sqlite.prepare(`SELECT phase, coverage_total, coverage_digest, approved_by, approval_reference
    FROM pharmacy_patient_intake_migration_state WHERE line_account_id = 'account-a'`).get() as
    { phase: string; coverage_total: number; coverage_digest: string;
      approved_by: string; approval_reference: string } | undefined;
}

function responseFields(sqlite: InstanceType<typeof Sqlite>, id: string) {
  return sqlite.prepare(`SELECT patient_snapshot_json, answers_json
    FROM pharmacy_patient_intake_responses WHERE id = ?`).get(id) as
    { patient_snapshot_json: string; answers_json: string };
}

describe('FLE migration helper atomicity (F1-F5)', () => {
  it('scrubs then restores in a single guarded batch per page', async () => {
    const { db, sqlite } = seedBase();
    const rowA = seedResponse(sqlite, 'resp-a', '{"name":"synthetic-a"}', '{"allergiesStatus":"none"}');
    const rowB = seedResponse(sqlite, 'resp-b', '{"name":"synthetic-b"}', '{"allergiesStatus":"yes"}');
    await seedEnvelopes(sqlite, rowA, rowA.patient_snapshot_json, rowA.answers_json);
    await seedEnvelopes(sqlite, rowB, rowB.patient_snapshot_json, rowB.answers_json);
    const approval = await approvalFor(db, 'admin-a');
    const frozen = await freezePatientIntakeWrites(db, CRYPTO, approval);
    expect(frozen.errorCode).toBeNull();
    expect(migrationState(sqlite)?.phase).toBe('frozen');

    const scrubbed = await scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(scrubbed).toMatchObject({
      counts: { scanned: 2, verified: 2, scrubbed: 2 }, errorCode: null, nextCursor: null,
    });
    expect(migrationState(sqlite)?.phase).toBe('scrubbed');
    expect(responseFields(sqlite, 'resp-a')).toEqual({
      patient_snapshot_json: '{}', answers_json: '{}',
    });

    const restored = await restorePatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(restored).toMatchObject({
      counts: { scanned: 2, verified: 2, restored: 2 }, errorCode: null, nextCursor: null,
    });
    expect(migrationState(sqlite)?.phase).toBe('restored');
    expect(responseFields(sqlite, 'resp-a').patient_snapshot_json).toBe('{"name":"synthetic-a"}');
    expect(responseFields(sqlite, 'resp-b').answers_json).toBe('{"allergiesStatus":"yes"}');
  });

  it('F3: dryRun never writes approval rebind or page data', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-a');
    await seedEnvelopes(sqlite, row, row.patient_snapshot_json, row.answers_json);
    const approval = await approvalFor(db, 'admin-a');
    await freezePatientIntakeWrites(db, CRYPTO, approval);
    await scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(migrationState(sqlite)?.phase).toBe('scrubbed');

    const otherApproval = await approvalFor(db, 'admin-b');
    const dryRun = await restorePatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: true, approval: otherApproval,
    });
    expect(dryRun.errorCode).toBeNull();
    const state = migrationState(sqlite);
    expect(state?.phase).toBe('scrubbed');
    expect(state?.approved_by).toBe('admin-a');
    expect(responseFields(sqlite, 'resp-a')).toEqual({
      patient_snapshot_json: '{}', answers_json: '{}',
    });
  });

  it('F1: rolls the whole batch back when the state guard is stale', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-a');
    await seedEnvelopes(sqlite, row, row.patient_snapshot_json, row.answers_json);
    const approval = await approvalFor(db, 'admin-a');
    await freezePatientIntakeWrites(db, CRYPTO, approval);

    const innerBatch = db.batch.bind(db);
    const racing = {
      ...db,
      batch: async (statements: D1PreparedStatement[]) => {
        sqlite.prepare(`UPDATE pharmacy_patient_intake_migration_state
          SET phase = 'restored' WHERE line_account_id = 'account-a'`).run();
        return innerBatch(statements);
      },
    } as D1Database;

    const report = await scrubPatientIntakeLegacyFields(racing, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(report.errorCode).toBe('CAS_CONFLICT');
    expect(migrationState(sqlite)?.phase).toBe('restored');
    expect(responseFields(sqlite, 'resp-a').patient_snapshot_json).not.toBe('{}');
  });

  it('F2: refuses terminal completion while uncovered plaintext remains in scope', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-a');
    await seedEnvelopes(sqlite, row, row.patient_snapshot_json, row.answers_json);
    const approval = await approvalFor(db, 'admin-a');
    await freezePatientIntakeWrites(db, CRYPTO, approval);

    const innerBatch = db.batch.bind(db);
    const racing = {
      ...db,
      batch: async (statements: D1PreparedStatement[]) => {
        const injected = seedResponse(sqlite, 'resp-sneak', '{"name":"synthetic-sneak"}', '{"x":"y"}');
        await seedEnvelopes(sqlite, injected, injected.patient_snapshot_json, injected.answers_json);
        return innerBatch(statements);
      },
    } as D1Database;

    const report = await scrubPatientIntakeLegacyFields(racing, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(report.errorCode).toBe('CAS_CONFLICT');
    expect(migrationState(sqlite)?.phase).toBe('frozen');
    expect(responseFields(sqlite, 'resp-a').patient_snapshot_json).toBe('{"name":"synthetic"}');
  });

  it('F5: restores a changed dataset only under a fresh approval that attests it', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-a');
    await seedEnvelopes(sqlite, row, row.patient_snapshot_json, row.answers_json);
    const approval = await approvalFor(db, 'admin-a');
    await freezePatientIntakeWrites(db, CRYPTO, approval);
    await scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(migrationState(sqlite)?.phase).toBe('scrubbed');

    const late = seedResponse(sqlite, 'resp-late', '{}', '{}');
    await seedEnvelopes(sqlite, late, '{"name":"synthetic-late"}', '{"allergiesStatus":"late"}');

    const staleApproval = await restorePatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval,
    });
    expect(staleApproval.errorCode).toBe('COVERAGE_MISMATCH');

    const freshApproval = await approvalFor(db, 'admin-b');
    const restored = await restorePatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 50, dryRun: false, approval: freshApproval,
    });
    expect(restored.errorCode).toBeNull();
    expect(migrationState(sqlite)).toMatchObject({ phase: 'restored', approved_by: 'admin-b' });
    expect(responseFields(sqlite, 'resp-late').patient_snapshot_json).toBe('{"name":"synthetic-late"}');
    expect(responseFields(sqlite, 'resp-a').patient_snapshot_json).toBe('{"name":"synthetic"}');
  });

  it('F4: rejects a frozen snapshot whose row count drifted before the fence landed', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-a');
    await seedEnvelopes(sqlite, row, row.patient_snapshot_json, row.answers_json);
    const approval = await approvalFor(db, 'admin-a');

    const innerPrepare = db.prepare.bind(db);
    const racing = {
      ...db,
      prepare: (sql: string) => {
        const statement = innerPrepare(sql);
        if (!sql.includes('INSERT INTO pharmacy_patient_intake_migration_state')) return statement;
        return {
          ...statement,
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              ...bound,
              run: async () => {
                const injected = seedResponse(sqlite, 'resp-sneak', '{"name":"sneak"}', '{"x":"y"}');
                await seedEnvelopes(sqlite, injected, injected.patient_snapshot_json, injected.answers_json);
                return bound.run();
              },
            };
          },
        };
      },
    } as D1Database;

    const frozen = await freezePatientIntakeWrites(racing, CRYPTO, approval);
    expect(frozen.errorCode).toBe('STORAGE_FAILED');
    expect(migrationState(sqlite)).toBeUndefined();
  });
});

describe('FLE dual-read tenant boundary (F6)', () => {
  it('returns legacy plaintext only for a mapped tenant/account pair', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-legacy');
    const opened = await openPatientIntakeFields(db, row, CRYPTO);
    expect(opened.patient_snapshot_json).toBe('{"name":"synthetic"}');
    await expect(openPatientIntakeFields(db, row, {
      ...CRYPTO, tenantId: 'tenant-b',
    })).rejects.toThrow('Invalid patient intake envelope');
  });

  it('rejects sentinel-only and mixed-sentinel rows without envelopes', async () => {
    const { db, sqlite } = seedBase();
    const sentinel = seedResponse(sqlite, 'resp-sentinel', '{}', '{}');
    await expect(openPatientIntakeFields(db, sentinel, CRYPTO)).rejects.toThrow();
    const mixed = seedResponse(sqlite, 'resp-mixed', '{}', '{"allergiesStatus":"none"}');
    await expect(openPatientIntakeFields(db, mixed, CRYPTO)).rejects.toThrow();
  });

  it('rejects a partial envelope set instead of falling back', async () => {
    const { db, sqlite } = seedBase();
    const row = seedResponse(sqlite, 'resp-partial');
    const envelope = await sealPatientIntakeField(
      row.patient_snapshot_json,
      CRYPTO.rootSecret,
      patientIntakeEncryptionContext(row, CRYPTO, 'patient_snapshot_json'),
    );
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_envelopes
      (response_id, tenant_id, line_account_id, owner_friend_id, patient_id, field_name,
       schema_version, source_revision, envelope_version, key_version, nonce,
       ciphertext, encrypted_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'patient-a', 'patient_snapshot_json',
       ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id, row.schema_version, row.revision, envelope.envelopeVersion,
        envelope.keyVersion, envelope.nonce, envelope.ciphertext, NOW,
      );
    await expect(openPatientIntakeFields(db, row, CRYPTO)).rejects.toThrow();
  });
});

describe('FLE migration report cursor (F7)', () => {
  it('returns an opaque operation-scoped cursor that never serializes the row id', async () => {
    const { db, sqlite } = seedBase();
    const rowA = seedResponse(sqlite, 'resp-cursor-a');
    const rowB = seedResponse(sqlite, 'resp-cursor-b');
    await seedEnvelopes(sqlite, rowA, rowA.patient_snapshot_json, rowA.answers_json);
    await seedEnvelopes(sqlite, rowB, rowB.patient_snapshot_json, rowB.answers_json);
    const approval = await approvalFor(db, 'admin-a');
    await freezePatientIntakeWrites(db, CRYPTO, approval);

    const first = await scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: null, limit: 1, dryRun: true, approval,
    });
    expect(first.errorCode).toBeNull();
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(JSON.stringify(first)).not.toContain('resp-cursor-a');
    expect(JSON.stringify(first)).not.toContain('resp-cursor-b');

    const resumed = await scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: first.nextCursor, limit: 1, dryRun: true, approval,
    });
    expect(resumed.errorCode).toBeNull();
    expect(resumed.counts.scanned).toBe(1);

    await expect(restorePatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: first.nextCursor, limit: 1, dryRun: true, approval,
    })).resolves.toMatchObject({ errorCode: 'INVALID_INPUT' });
    await expect(scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: `${first.nextCursor}x`, limit: 1, dryRun: true, approval,
    })).resolves.toMatchObject({ errorCode: 'INVALID_INPUT' });
    await expect(scrubPatientIntakeLegacyFields(db, {
      ...CRYPTO, cursor: 'resp-cursor-b', limit: 1, dryRun: true, approval,
    })).resolves.toMatchObject({ errorCode: 'INVALID_INPUT' });
  });
});
