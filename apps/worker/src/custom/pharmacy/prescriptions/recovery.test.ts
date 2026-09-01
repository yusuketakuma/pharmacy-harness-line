import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { getPrescriptionRecovery } from './repository.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type SqliteDatabase = { exec(sql: string): void; prepare(sql: string): SqliteStatement };
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => SqliteDatabase;

function d1From(sqlite: SqliteDatabase, afterAll?: (sql: string) => void): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => {
          const results = sqlite.prepare(sql).all(...values);
          afterAll?.(sql);
          return { results };
        },
      }),
    }),
  } as unknown as D1Database;
}

const patient = { lineAccountId: 'account-a', friendId: 'friend-a' };

describe('prescription recovery projection', () => {
  let sqlite: SqliteDatabase;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.exec(`
      CREATE TABLE pharmacy_prescription_submissions (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL, active_revision INTEGER, upload_revision INTEGER NOT NULL,
        desired_pickup_at TEXT, desired_fulfillment_method TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_prescription_patients (
        submission_id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL,
        owner_friend_id TEXT NOT NULL, patient_id TEXT NOT NULL
      );
      CREATE TABLE pharmacy_prescription_files (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, revision INTEGER NOT NULL,
        position INTEGER NOT NULL, state TEXT NOT NULL, sha256 TEXT NOT NULL
      );
    `);
    db = d1From(sqlite);
  });

  function insertSubmission(input: {
    id: string;
    account?: string;
    owner?: string;
    status?: string;
    activeRevision?: number | null;
    uploadRevision?: number;
    patientId?: string | null;
    idempotencyKey?: string;
  }) {
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions (
      id, line_account_id, friend_id, idempotency_key, status, active_revision,
      upload_revision, desired_pickup_at, desired_fulfillment_method, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id,
      input.account ?? 'account-a',
      input.owner ?? 'friend-a',
      input.idempotencyKey ?? `attempt-${input.id}`,
      input.status ?? 'draft',
      input.activeRevision ?? null,
      input.uploadRevision ?? 1,
      '2026-09-02T03:00:00.000Z',
      'PICKUP',
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:01.000Z',
    );
    if (input.patientId !== null) {
      sqlite.prepare(`INSERT INTO pharmacy_prescription_patients VALUES (?, ?, ?, ?)`).run(
        input.id,
        input.account ?? 'account-a',
        input.owner ?? 'friend-a',
        input.patientId ?? 'patient-a',
      );
    }
  }

  it('returns only the current owned revision with transient patient binding', async () => {
    insertSubmission({ id: 'draft-a', uploadRevision: 2 });
    insertSubmission({ id: 'other-owner', owner: 'friend-b' });
    insertSubmission({ id: 'other-account', account: 'account-b' });
    const insertFile = sqlite.prepare(`INSERT INTO pharmacy_prescription_files VALUES
      (?, ?, ?, ?, ?, ?)`);
    insertFile.run('old-ready', 'draft-a', 1, 1, 'ready', 'old-sha');
    insertFile.run('current-ready', 'draft-a', 2, 1, 'ready', 'ready-sha');
    insertFile.run('current-pending', 'draft-a', 2, 2, 'pending', 'pending-sha');
    insertFile.run('current-deleted', 'draft-a', 2, 3, 'deleted', 'deleted-sha');

    await expect(getPrescriptionRecovery(db, patient)).resolves.toEqual({
      state: 'recoverable',
      submission: {
        id: 'draft-a',
        status: 'draft',
        uploadRevision: 2,
        updatedAt: '2026-09-01T00:00:01.000Z',
        patientId: 'patient-a',
        desiredPickupAt: '2026-09-02T03:00:00.000Z',
        desiredFulfillmentMethod: 'PICKUP',
        readyPositions: [1],
        pendingPositions: [2],
      },
    });
  });

  it('does not auto-select multiple drafts or an unbound patient', async () => {
    insertSubmission({ id: 'draft-a' });
    insertSubmission({ id: 'draft-b' });
    await expect(getPrescriptionRecovery(db, patient)).resolves.toEqual({
      state: 'ambiguous', reason: 'multiple',
    });

    sqlite.exec('DELETE FROM pharmacy_prescription_patients; DELETE FROM pharmacy_prescription_submissions;');
    insertSubmission({ id: 'unbound', patientId: null });
    await expect(getPrescriptionRecovery(db, patient)).resolves.toEqual({
      state: 'ambiguous', reason: 'patient_binding_unavailable',
    });
  });

  it('correlates an unknown reserve outcome without selecting another owned draft', async () => {
    insertSubmission({ id: 'draft-a', idempotencyKey: 'attempt-a' });
    insertSubmission({ id: 'draft-b', idempotencyKey: 'attempt-b' });

    await expect(getPrescriptionRecovery(db, patient, {
      idempotencyKey: 'attempt-a',
    })).resolves.toMatchObject({
      state: 'recoverable', submission: { id: 'draft-a' },
    });
    await expect(getPrescriptionRecovery(db, patient, {
      idempotencyKey: 'attempt-missing',
    })).resolves.toEqual({ state: 'none' });
  });

  it('keeps recovery selectors inside the server-resolved owner scope', async () => {
    insertSubmission({ id: 'other-owner', owner: 'friend-b', idempotencyKey: 'attempt-shared' });
    insertSubmission({ id: 'other-account', account: 'account-b', idempotencyKey: 'attempt-shared' });

    await expect(getPrescriptionRecovery(db, patient, {
      idempotencyKey: 'attempt-shared',
    })).resolves.toEqual({ state: 'none' });
    await expect(getPrescriptionRecovery(db, patient, {
      submissionId: 'other-owner',
    })).resolves.toEqual({ state: 'none' });
  });

  it('returns file slots from the same upload revision as the recovery candidate', async () => {
    insertSubmission({ id: 'draft-a', uploadRevision: 1 });
    const insertFile = sqlite.prepare(`INSERT INTO pharmacy_prescription_files VALUES
      (?, ?, ?, ?, ?, ?)`);
    insertFile.run('revision-1', 'draft-a', 1, 1, 'ready', 'sha-1');
    insertFile.run('revision-2', 'draft-a', 2, 2, 'pending', 'sha-2');
    let advanced = false;
    db = d1From(sqlite, (sql) => {
      if (!advanced && sql.includes('SELECT s.id, s.status')) {
        advanced = true;
        sqlite.prepare(`UPDATE pharmacy_prescription_submissions
          SET upload_revision = 2 WHERE id = ?`).run('draft-a');
      }
    });

    await expect(getPrescriptionRecovery(db, patient)).resolves.toMatchObject({
      state: 'recoverable',
      submission: { uploadRevision: 1, readyPositions: [1], pendingPositions: [] },
    });
  });

  it('recovers needs_resubmission only after a new upload revision is reserved', async () => {
    insertSubmission({
      id: 'not-reserved', status: 'needs_resubmission', activeRevision: 2, uploadRevision: 2,
    });
    await expect(getPrescriptionRecovery(db, patient)).resolves.toEqual({ state: 'none' });

    sqlite.exec('DELETE FROM pharmacy_prescription_patients; DELETE FROM pharmacy_prescription_submissions;');
    insertSubmission({
      id: 'reserved', status: 'needs_resubmission', activeRevision: 2, uploadRevision: 3,
    });
    await expect(getPrescriptionRecovery(db, patient)).resolves.toMatchObject({
      state: 'recoverable', submission: { id: 'reserved', uploadRevision: 3 },
    });
  });
});
