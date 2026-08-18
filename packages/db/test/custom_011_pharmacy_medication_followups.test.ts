import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listPatientMedicationFollowUps,
  listDueMedicationFollowUps,
  parseMedicationFollowUpPostback,
  recordMedicationFollowUpPatientResponse,
  scheduleMedicationFollowUp,
  transitionMedicationFollowUp,
} from '../../../apps/worker/src/custom/pharmacy/medication-followup/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(
  join(ROOT, 'migrations/custom_011_pharmacy_medication_followups.sql'),
  'utf8',
);

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };
function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>),
    )(),
  } as unknown as D1Database;
}

function seedAccount(db: Database.Database, suffix: 'a' | 'b'): void {
  const accountId = `account-${suffix}`;
  const friendId = `friend-${suffix}`;
  const patientId = `patient-${suffix}`;
  const submissionId = `submission-${suffix}`;
  const intakeId = `intake-${suffix}`;
  const now = '2026-08-18T00:00:00.000Z';
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, `channel-${suffix}`, suffix.toUpperCase(), `token-${suffix}`, `secret-${suffix}`, now, now);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`)
    .run(friendId, `U-${suffix}`, accountId, now, now);
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, 'self', ?, ?, '1990-01-01', ?, ?)`)
    .run(patientId, accountId, friendId, `Patient ${suffix}`, `PATIENT ${suffix}`, now, now);
  db.prepare(`INSERT INTO pharmacy_patient_intake_responses
    (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
     patient_snapshot_json, answers_json, idempotency_key,
     representative_consent_at, privacy_consent_at, created_at)
    VALUES (?, ?, ?, ?, 1, 1, '{}', '{}', ?, ?, ?, ?)`)
    .run(intakeId, accountId, friendId, patientId, `intake-key-${suffix}`, now, now, now);
  db.prepare(`INSERT INTO pharmacy_prescription_submissions
    (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
     closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'closed', 1, ?, ?, ?)`)
    .run(submissionId, accountId, friendId, `submission-key-${suffix}`, now, now, now);
  db.prepare(`INSERT INTO pharmacy_prescription_patients
    (submission_id, line_account_id, owner_friend_id, patient_id,
     intake_response_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(submissionId, accountId, friendId, patientId, intakeId, now);
}

function insertFollowUp(db: Database.Database): void {
  db.prepare(`INSERT INTO pharmacy_medication_followups
    (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
     status, due_at, created_by, created_at, updated_at)
    VALUES ('followup-a', 'account-a', 'friend-a', 'patient-a', 'submission-a',
            'scheduled', '2026-08-21T00:00:00.000Z', 'staff-a',
            '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`).run();
}

describe('custom_011 pharmacy medication follow-ups', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = loadDb();
    d1 = d1From(db);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    db.prepare(`INSERT INTO pharmacy_account_capabilities
      (line_account_id, mode, capabilities_json, created_at, updated_at)
      VALUES ('account-a', 'pharmacy', '["medication_followup"]',
              '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`).run();
  });

  it('stores only the bounded workflow state and no clinical payload', () => {
    const columns = db.prepare('PRAGMA table_info(pharmacy_medication_followups)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'line_account_id', 'owner_friend_id', 'patient_id', 'source_submission_id',
      'status', 'due_at', 'version',
    ]));
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'drug_name', 'disease', 'note', 'message', 'payload_json', 'line_user_id',
    ]));
  });

  it('enforces account, friend, patient, and submission boundaries', () => {
    insertFollowUp(db);
    expect(() => db.prepare(`INSERT INTO pharmacy_medication_followups
      (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
       status, due_at, created_by, created_at, updated_at)
      VALUES ('followup-cross', 'account-b', 'friend-b', 'patient-b', 'submission-a',
              'scheduled', '2026-08-21T00:00:00.000Z', 'staff-b',
              '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare(`INSERT INTO pharmacy_medication_followup_events
      (id, followup_id, line_account_id, event_type, to_status, actor_type,
       idempotency_key, occurred_at)
      VALUES ('event-cross', 'followup-a', 'account-b', 'scheduled', 'scheduled',
              'staff', 'event-cross', '2026-08-18T00:00:00.000Z')`).run())
      .toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('keeps event replay idempotent inside each account', () => {
    insertFollowUp(db);
    const insert = db.prepare(`INSERT INTO pharmacy_medication_followup_events
      (id, followup_id, line_account_id, event_type, to_status, actor_type,
       idempotency_key, occurred_at)
      VALUES (?, 'followup-a', 'account-a', 'scheduled', 'scheduled',
              'staff', 'schedule:submission-a', '2026-08-18T00:00:00.000Z')`);
    insert.run('event-a');
    expect(() => insert.run('event-b')).toThrow(/UNIQUE constraint failed/i);
  });

  it('reapplies without duplicating schema objects', () => {
    expect(() => db.exec(MIGRATION)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'pharmacy_medication_followup%'`).get())
      .toEqual({ count: 2 });
  });

  it('schedules one follow-up from a closed, account-scoped submission', async () => {
    const input = {
      lineAccountId: 'account-a',
      submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z',
      staffId: 'staff-a',
      idempotencyKey: 'request-schedule-a',
      now: new Date('2026-08-18T00:00:00.000Z'),
    };
    const first = await scheduleMedicationFollowUp(d1, input);
    const retry = await scheduleMedicationFollowUp(d1, input);

    expect(retry.id).toBe(first.id);
    expect(first).toMatchObject({
      line_account_id: 'account-a',
      owner_friend_id: 'friend-a',
      patient_id: 'patient-a',
      source_submission_id: 'submission-a',
      status: 'scheduled',
      version: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pharmacy_medication_followups').get())
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pharmacy_medication_followup_events').get())
      .toEqual({ count: 1 });
    await expect(scheduleMedicationFollowUp(d1, { ...input, lineAccountId: 'account-b' }))
      .rejects.toThrow(/eligible closed submission/i);
  });

  it('does not reuse one scheduling idempotency key for another submission', async () => {
    const now = '2026-08-18T00:00:00.000Z';
    db.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
       closed_at, created_at, updated_at)
      VALUES ('submission-a2', 'account-a', 'friend-a', 'submission-key-a2',
              'closed', 1, ?, ?, ?)`).run(now, now, now);
    db.prepare(`INSERT INTO pharmacy_prescription_patients
      (submission_id, line_account_id, owner_friend_id, patient_id,
       intake_response_id, created_at)
      VALUES ('submission-a2', 'account-a', 'friend-a', 'patient-a', 'intake-a', ?)`)
      .run(now);
    const base = {
      lineAccountId: 'account-a', dueAt: '2026-08-21T09:00:00.000Z',
      staffId: 'staff-a', idempotencyKey: 'same-request-key',
      now: new Date(now),
    };
    await scheduleMedicationFollowUp(d1, { ...base, submissionId: 'submission-a' });
    await expect(scheduleMedicationFollowUp(d1, { ...base, submissionId: 'submission-a2' }))
      .rejects.toThrow(/conflict/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM pharmacy_medication_followups').get())
      .toEqual({ count: 1 });
  });

  it('allows only optimistic, audited workflow transitions', async () => {
    let row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-transition-a', now: new Date('2026-08-18T00:00:00.000Z'),
    });
    await expect(transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'assigned',
      expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
      now: new Date('2026-08-18T00:01:00.000Z'),
    })).rejects.toThrow(/invalid follow-up transition/i);

    for (const toStatus of ['due', 'delivered', 'concern', 'assigned', 'responded', 'closed'] as const) {
      row = await transitionMedicationFollowUp(d1, {
        lineAccountId: 'account-a', followUpId: row.id, toStatus,
        expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
        now: new Date(`2026-08-18T00:0${row.version}:00.000Z`),
      });
    }
    expect(row).toMatchObject({ status: 'closed', version: 7, assigned_to: 'staff-a' });
    await expect(transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'cancelled',
      expectedVersion: 1, actorType: 'staff', actorId: 'staff-a',
    })).rejects.toThrow(/conflict|invalid follow-up transition/i);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM pharmacy_medication_followup_events
      WHERE followup_id = ?`).get(row.id)).toEqual({ count: 7 });
  });

  it('records a fixed patient response once and rejects cross-friend access', async () => {
    let row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-response-a', now: new Date('2026-08-18T00:00:00.000Z'),
    });
    for (const toStatus of ['due', 'delivered'] as const) {
      row = await transitionMedicationFollowUp(d1, {
        lineAccountId: 'account-a', followUpId: row.id, toStatus,
        expectedVersion: row.version, actorType: 'system', actorId: 'cron',
      });
    }
    const action = parseMedicationFollowUpPostback(
      `pharmacy-followup:${row.id}:concern`,
    );
    expect(action).toEqual({ followUpId: row.id, response: 'concern' });
    expect(parseMedicationFollowUpPostback(`pharmacy-followup:${row.id}:free-text`)).toBeNull();

    const webhookEventId = 'w'.repeat(128);
    const first = await recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a',
      ...action!, webhookEventId,
    });
    const retry = await recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a',
      ...action!, webhookEventId,
    });
    expect(first).toMatchObject({ status: 'concern', responded_at: expect.any(String) });
    expect(retry).toEqual(first);
    await expect(recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-b',
      ...action!, webhookEventId: 'webhook-event-b',
    })).rejects.toThrow(/follow-up response unavailable/i);
    await expect(listPatientMedicationFollowUps(d1, 'account-a', 'patient-a'))
      .resolves.toEqual([expect.objectContaining({ id: row.id, status: 'concern' })]);
    await expect(listPatientMedicationFollowUps(d1, 'account-b', 'patient-a'))
      .resolves.toEqual([]);
  });

  it('lists only due, following patients for accounts with the capability', async () => {
    const row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-due-a', now: new Date('2026-08-18T00:00:00.000Z'),
    });
    await expect(listDueMedicationFollowUps(
      d1, new Date('2026-08-21T08:59:59.000Z'),
    )).resolves.toEqual([]);
    await expect(listDueMedicationFollowUps(
      d1, new Date('2026-08-21T09:00:00.000Z'),
    )).resolves.toEqual([expect.objectContaining({
      id: row.id,
      line_account_id: 'account-a',
      line_user_id: 'U-a',
      channel_access_token: 'token-a',
    })]);
    db.prepare(`UPDATE friends SET is_following = 0 WHERE id = 'friend-a'`).run();
    await expect(listDueMedicationFollowUps(
      d1, new Date('2026-08-22T00:00:00.000Z'),
    )).resolves.toEqual([]);
  });
});
