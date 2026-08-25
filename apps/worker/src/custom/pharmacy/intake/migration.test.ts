import { describe, expect, it } from 'vitest';
import { openPatientIntakeField, sealPatientIntakeField } from './encryption.js';
import {
  patientIntakeEncryptionContext,
  type PatientIntakeEncryptedRow,
} from './envelopes.js';
import {
  backfillPatientIntakeEnvelopes,
  inspectPatientIntakeBackfillCoverage,
  inspectPatientIntakeCoverage,
  patientIntakeRecoveryMetadata,
} from './migration.js';

describe('patient intake envelope backfill', () => {
  it('stores two scoped envelopes that decrypt to the original bytes', async () => {
    const row: PatientIntakeEncryptedRow = {
      id: 'response-a',
      line_account_id: 'account-a',
      owner_friend_id: 'friend-a',
      patient_id: 'patient-a',
      revision: 2,
      schema_version: 1,
      patient_snapshot_json: '{"name":"synthetic"}',
      answers_json: '{"allergiesStatus":"none"}',
    };
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            const statement = {
              sql,
              values,
              first: async () => sql.includes('FROM tenant_line_accounts mapping')
                ? { found: 1 }
                : null,
              all: async () => ({
                results: sql.includes('FROM pharmacy_patient_intake_responses response')
                  ? [row]
                  : [],
              }),
              run: async () => ({ meta: { changes: 1 } }),
            };
            if (sql.includes('INSERT INTO pharmacy_patient_intake_envelopes')) {
              inserts.push(statement);
            }
            return statement;
          },
        };
      },
      batch: async (statements: unknown[]) =>
        statements.map(() => ({ meta: { changes: 1 } })),
    } as unknown as D1Database;
    const scope = {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      rootSecret: 's'.repeat(32),
    };

    const report = await backfillPatientIntakeEnvelopes(db, {
      ...scope,
      cursor: null,
      limit: 1,
      dryRun: false,
    });

    expect(report).toMatchObject({
      counts: { scanned: 1, verified: 1, inserted: 1, conflicts: 0 },
      errorCode: null,
    });
    expect(inserts).toHaveLength(2);
    for (const { values } of inserts) {
      const fieldName = values[5] as 'patient_snapshot_json' | 'answers_json';
      expect(values.slice(0, 8)).toEqual([
        row.id,
        scope.tenantId,
        row.line_account_id,
        row.owner_friend_id,
        row.patient_id,
        fieldName,
        row.schema_version,
        row.revision,
      ]);
      const opened = await openPatientIntakeField({
        envelopeVersion: values[8] as number,
        keyVersion: values[9] as number,
        nonce: values[10] as string,
        ciphertext: values[11] as string,
      }, scope.rootSecret, patientIntakeEncryptionContext(row, scope, fieldName));
      expect(opened).toBe(row[fieldName]);
      expect(values[11]).not.toBe(row[fieldName]);
      expect(Number.isNaN(Date.parse(values[12] as string))).toBe(false);
    }
  });

  it('builds coverage evidence from ciphertext and schema metadata, never decrypted PHI', async () => {
    const scope = {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      rootSecret: 's'.repeat(32),
    };
    const row: PatientIntakeEncryptedRow = {
      id: 'response-a',
      line_account_id: scope.lineAccountId,
      owner_friend_id: 'friend-a',
      patient_id: 'patient-a',
      revision: 2,
      schema_version: 1,
      patient_snapshot_json: '{}',
      answers_json: '{}',
    };
    const fields = await Promise.all([
      ['patient_snapshot_json', '{"lowEntropy":"yes"}'],
      ['answers_json', '{"lowEntropy":"no"}'],
    ] as const).then(async (entries) => Promise.all(entries.map(async ([fieldName, plaintext]) => {
      const envelope = await sealPatientIntakeField(
        plaintext,
        scope.rootSecret,
        patientIntakeEncryptionContext(row, scope, fieldName),
      );
      return {
        field_name: fieldName,
        envelope_version: envelope.envelopeVersion,
        key_version: envelope.keyVersion,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
      };
    })));
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => sql.includes('FROM tenant_line_accounts mapping') ? { found: 1 } : null,
              all: async () => sql.includes('FROM pharmacy_patient_intake_responses response')
                ? { results: [row] }
                : { results: fields },
              run: async () => ({ meta: { changes: 1 } }),
              values,
            };
          },
        };
      },
    } as unknown as D1Database;

    const report = await inspectPatientIntakeCoverage(db, scope);
    const metadata = JSON.stringify([
      row.id,
      row.revision,
      row.schema_version,
      ...fields.map((envelope) => ({
        fieldName: envelope.field_name,
        envelopeVersion: envelope.envelope_version,
        keyVersion: envelope.key_version,
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
      })),
    ]);
    const hmacKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(scope.rootSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const partBytes = new Uint8Array(await crypto.subtle.sign(
      'HMAC', hmacKey, new TextEncoder().encode(metadata),
    ));
    const partDigest = [...partBytes].map((item) => item.toString(16).padStart(2, '0')).join('');
    const expectedBytes = new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(partDigest),
    ));
    const expected = [...expectedBytes].map((item) => item.toString(16).padStart(2, '0')).join('');
    expect(report).toMatchObject({ counts: { scanned: 1, covered: 1 }, errorCode: null });
    expect(report.coverageDigest).toBe(expected);
    expect(report.coverageDigest).not.toBe(
      await (async () => {
        const bytes = new Uint8Array(await crypto.subtle.digest(
          'SHA-256', new TextEncoder().encode('{"lowEntropy":"yes"}{"lowEntropy":"no"}'),
        ));
        return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
      })(),
    );
  });

  it('uses keyed inventory evidence while backfill is still plaintext', async () => {
    const scope = {
      tenantId: 'tenant-a', lineAccountId: 'account-a', rootSecret: 's'.repeat(32),
    };
    const row: PatientIntakeEncryptedRow = {
      id: 'response-a', line_account_id: 'account-a', owner_friend_id: 'friend-a',
      patient_id: 'patient-a', revision: 3, schema_version: 2,
      patient_snapshot_json: '{"name":"synthetic"}',
      answers_json: '{"allergiesStatus":"none"}',
    };
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => sql.includes('FROM tenant_line_accounts mapping') ? { found: 1 } : null,
              all: async () => sql.includes('FROM pharmacy_patient_intake_responses response')
                ? { results: [row] } : { results: [] },
            };
          },
        };
      },
    } as unknown as D1Database;

    const [report, metadata] = await Promise.all([
      inspectPatientIntakeBackfillCoverage(db, scope),
      patientIntakeRecoveryMetadata(),
    ]);
    expect(report).toMatchObject({
      counts: { scanned: 1, covered: 1 }, coverageTotal: 1, errorCode: null,
    });
    expect(report.coverageDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(metadata).toMatchObject({ keyVersions: ['1'] });
    expect(metadata.schemaDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(metadata.fieldInventoryDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps the backfill commitment opaque while binding root key, row identity, and field bytes', async () => {
    const scope = {
      tenantId: 'tenant-a', lineAccountId: 'account-a', rootSecret: 's'.repeat(32),
    };
    let row: PatientIntakeEncryptedRow = {
      id: 'response-a', line_account_id: 'account-a', owner_friend_id: 'friend-a',
      patient_id: 'patient-a', revision: 3, schema_version: 2,
      patient_snapshot_json: '{"name":"synthetic-a"}',
      answers_json: '{"allergiesStatus":"none"}',
    };
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              first: async () => sql.includes('FROM tenant_line_accounts mapping') ? { found: 1 } : null,
              all: async () => sql.includes('FROM pharmacy_patient_intake_responses response')
                ? { results: [row] } : { results: [] },
            };
          },
        };
      },
    } as unknown as D1Database;

    const first = await inspectPatientIntakeBackfillCoverage(db, scope);
    const changedKey = await inspectPatientIntakeBackfillCoverage(db, {
      ...scope, rootSecret: 't'.repeat(32),
    });
    row = { ...row, patient_snapshot_json: '{"name":"synthetic-b"}' };
    const changedPlaintext = await inspectPatientIntakeBackfillCoverage(db, scope);
    row = { ...row, id: 'response-b', patient_snapshot_json: '{"name":"synthetic-a"}' };
    const changedRecord = await inspectPatientIntakeBackfillCoverage(db, scope);

    expect(first.coverageDigest).not.toBe(changedKey.coverageDigest);
    expect(first.coverageDigest).not.toBe(changedPlaintext.coverageDigest);
    expect(first.coverageDigest).not.toBe(changedRecord.coverageDigest);
    expect(first.coverageDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.coverageDigest).not.toContain('synthetic-a');
  });
});
