import { describe, expect, it } from 'vitest';
import { openPatientIntakeField } from './encryption.js';
import {
  patientIntakeEncryptionContext,
  type PatientIntakeEncryptedRow,
} from './envelopes.js';
import { backfillPatientIntakeEnvelopes } from './migration.js';

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
});
