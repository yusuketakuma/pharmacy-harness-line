import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOwnerMedicationFollowUp,
  listPatientMedicationFollowUps,
  listOwnerMedicationFollowUps,
  listDueMedicationFollowUps,
  listMedicationFollowUpContacts,
  parseMedicationFollowUpPostback,
  recordMedicationFollowUpPatientResponse,
  recordMedicationFollowUpContact,
  scheduleMedicationFollowUp,
  transitionMedicationFollowUp,
} from '../../../apps/worker/src/custom/pharmacy/medication-followup/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`tenant-${suffix}`, `pharmacy-${suffix}`, `Tenant ${suffix}`, now, now);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`)
    .run(`tenant-${suffix}`, accountId, now, now);
  db.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, 'owner', ?, 1, ?, ?)`)
    .run(`staff-${suffix}`, `Staff ${suffix}`, `key-${suffix}`, now, now);
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'owner', 1, ?, ?)`)
    .run(`tenant-${suffix}`, `staff-${suffix}`, now, now);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)`)
    .run(accountId, `staff-${suffix}`, now, now);
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
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = CASE line_account_id
        WHEN 'account-a' THEN '["medication_followup"]'
        ELSE '[]'
      END
      WHERE line_account_id IN ('account-a', 'account-b')`).run();
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

  it('schedules one follow-up from a closed, account-scoped submission', async () => {
    const input = {
      lineAccountId: 'account-a',
      submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z',
      responseDeadlineAt: '2026-08-21T10:00:00.000Z',
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
      response_deadline_at: '2026-08-21T10:00:00.000Z',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pharmacy_medication_followups').get())
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM pharmacy_medication_followup_events').get())
      .toEqual({ count: 1 });
    await expect(scheduleMedicationFollowUp(d1, { ...input, lineAccountId: 'account-b' }))
      .rejects.toThrow(/eligible closed submission/i);
  });

  it('requires a meaningful contact record before staff can mark a concern responded or closed', async () => {
    let row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-contact-gate', now: new Date('2026-08-18T00:00:00.000Z'),
    });
    for (const toStatus of ['due', 'delivered', 'concern', 'assigned'] as const) {
      row = await transitionMedicationFollowUp(d1, {
        lineAccountId: 'account-a', followUpId: row.id, toStatus,
        expectedVersion: row.version, actorType: 'system', actorId: 'workflow-test',
        ...(toStatus === 'assigned' ? { assigneeStaffId: 'staff-a' } : {}),
      });
    }
    await expect(transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'responded',
      expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
    })).rejects.toThrow(/response record required/i);

    await expect(recordMedicationFollowUpContact(d1, {
      lineAccountId: 'account-a', followUpId: row.id, channel: 'phone',
      outcomeCode: 'no_answer', actorStaffId: 'staff-a',
      idempotencyKey: 'contact-no-answer', expectedVersion: row.version,
      now: new Date('2026-08-18T00:05:00.000Z'),
    })).resolves.toMatchObject({ outcome_code: 'no_answer' });
    await expect(transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'responded',
      expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
    })).rejects.toThrow(/response record required/i);

    await expect(recordMedicationFollowUpContact(d1, {
      lineAccountId: 'account-a', followUpId: row.id, channel: 'phone',
      outcomeCode: 'answered', actorStaffId: 'staff-a',
      idempotencyKey: 'contact-answered', expectedVersion: row.version,
      now: new Date('2026-08-18T00:06:00.000Z'),
    })).resolves.toMatchObject({ outcome_code: 'answered', channel: 'phone' });
    row = await transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'responded',
      expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
    });
    row = await transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'closed',
      expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
    });
    expect(row).toMatchObject({ status: 'closed', version: 7 });
    await expect(listMedicationFollowUpContacts(d1, 'account-a', row.id))
      .resolves.toEqual([
        expect.objectContaining({ outcome_code: 'answered' }),
        expect.objectContaining({ outcome_code: 'no_answer' }),
      ]);
    await expect(recordMedicationFollowUpContact(d1, {
      lineAccountId: 'account-b', followUpId: row.id, channel: 'line',
      outcomeCode: 'answered', actorStaffId: 'staff-b', idempotencyKey: 'contact-cross',
    })).rejects.toThrow(/not found|conflict/i);
  });

  it('validates follow-up contact timing and keeps contact idempotency account-scoped', async () => {
    const row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-contact-validation', now: new Date('2026-08-18T00:00:00.000Z'),
    });
    const input = {
      lineAccountId: 'account-a', followUpId: row.id, channel: 'line' as const,
      outcomeCode: 'follow_up_required' as const, actorStaffId: 'staff-a',
      idempotencyKey: 'contact-follow-up', expectedVersion: row.version,
      now: new Date('2026-08-18T00:00:00.000Z'),
    };
    await expect(recordMedicationFollowUpContact(d1, input))
      .rejects.toThrow(/next contact time is required/i);
    await expect(recordMedicationFollowUpContact(d1, {
      ...input, nextContactAt: '2026-08-17T00:00:00.000Z',
    })).rejects.toThrow(/next contact time must be in the future/i);
    const saved = await recordMedicationFollowUpContact(d1, {
      ...input, nextContactAt: '2026-08-21T10:00:00.000Z',
    });
    await expect(recordMedicationFollowUpContact(d1, {
      ...input, nextContactAt: '2026-08-21T10:00:00.000Z',
    })).resolves.toEqual(saved);
    await expect(recordMedicationFollowUpContact(d1, {
      ...input, outcomeCode: 'answered', nextContactAt: null,
    })).rejects.toThrow(/contact conflict/i);
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
      assigneeStaffId: 'staff-a',
      now: new Date('2026-08-18T00:01:00.000Z'),
    })).rejects.toThrow(/invalid follow-up transition/i);

    for (const toStatus of ['due', 'delivered', 'concern', 'assigned', 'responded', 'closed'] as const) {
      if (toStatus === 'responded') {
        await recordMedicationFollowUpContact(d1, {
          lineAccountId: 'account-a', followUpId: row.id, channel: 'phone',
          outcomeCode: 'answered', actorStaffId: 'staff-a',
          idempotencyKey: 'contact-transition-a', expectedVersion: row.version,
          now: new Date('2026-08-18T00:05:00.000Z'),
        });
      }
      row = await transitionMedicationFollowUp(d1, {
        lineAccountId: 'account-a', followUpId: row.id, toStatus,
        expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
        ...(toStatus === 'assigned' ? { assigneeStaffId: 'staff-a' } : {}),
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

  it('does not store the shared pharmacy principal as a human assignee', async () => {
    const now = '2026-08-18T00:00:00.000Z';
    db.prepare(`INSERT INTO staff_members
      (id, name, role, api_key, is_active, principal_kind, shared_tenant_id, created_at, updated_at)
      VALUES ('shared-a', '薬局共通', 'admin', 'shared-key', 1, 'pharmacy_shared', 'tenant-a', ?, ?)`)
      .run(now, now);
    db.prepare(`INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
      VALUES ('tenant-a', 'shared-a', 'admin', 1, ?, ?)`)
      .run(now, now);
    let row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-shared-assignee', now: new Date(now),
    });
    for (const toStatus of ['due', 'delivered', 'concern'] as const) {
      row = await transitionMedicationFollowUp(d1, {
        lineAccountId: 'account-a', followUpId: row.id, toStatus,
        expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
      });
    }
    await expect(transitionMedicationFollowUp(d1, {
      lineAccountId: 'account-a', followUpId: row.id, toStatus: 'assigned',
      expectedVersion: row.version, actorType: 'staff', actorId: 'staff-a',
      assigneeStaffId: 'shared-a',
    })).rejects.toThrow(/conflict/i);
    expect(db.prepare(`SELECT assigned_to FROM pharmacy_medication_followups WHERE id = ?`)
      .get(row.id)).toEqual({ assigned_to: null });
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
    db.prepare(`INSERT INTO pharmacy_patient_owner_controls
      (line_account_id, patient_id, owner_friend_id, binding_suspended_at, binding_reason_code, version, updated_at)
      VALUES ('account-a', 'patient-a', 'friend-a', '2026-08-18T00:00:00.000Z', 'binding_suspended', 1,
              '2026-08-18T00:00:00.000Z')`).run();
    await expect(recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a',
      ...action!, webhookEventId,
    })).rejects.toThrow(/follow-up response unavailable/i);
    await expect(recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-b',
      ...action!, webhookEventId: 'webhook-event-b',
    })).rejects.toThrow(/follow-up response unavailable/i);
    await expect(listPatientMedicationFollowUps(d1, 'account-a', 'patient-a'))
      .resolves.toEqual([expect.objectContaining({ id: row.id, status: 'concern' })]);
    await expect(listPatientMedicationFollowUps(d1, 'account-b', 'patient-a'))
      .resolves.toEqual([]);
  });

  it('allows an active minor proxy to read and answer, then hides the follow-up after revoke', async () => {
    const now = '2026-08-18T00:00:00.000Z';
    db.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date, created_at, updated_at)
      VALUES ('patient-child-a', 'account-a', 'friend-a', 'child', 'Proxy Child', 'PROXY CHILD',
              '2018-01-01', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key, representative_consent_at,
       privacy_consent_at, created_at)
      VALUES ('intake-child-a', 'account-a', 'friend-a', 'patient-child-a', 1, 1,
              '{}', '{}', 'intake-child-a-key', ?, ?, ?)`).run(now, now, now);
    db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('grant-child-a', 'account-a', 'patient-child-a', 'friend-a', 'patient_intake_v1',
              'self_attested_guardian', 1, ?, ?, '2099-01-01T00:00:00.000Z', 1, ?, ?)`).run(
      'a'.repeat(64), now, now, now,
    );
    db.prepare(`INSERT INTO pharmacy_prescription_submissions
      (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
       closed_at, created_at, updated_at)
      VALUES ('submission-child-a', 'account-a', 'friend-a', 'submission-child-a-key',
              'closed', 1, ?, ?, ?)`).run(now, now, now);
    db.prepare(`INSERT INTO pharmacy_prescription_patients
      (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
      VALUES ('submission-child-a', 'account-a', 'friend-a', 'patient-child-a', 'intake-child-a', ?)`).run(now);

    const row = await scheduleMedicationFollowUp(d1, {
      lineAccountId: 'account-a', submissionId: 'submission-child-a',
      dueAt: '2026-08-21T09:00:00.000Z', staffId: 'staff-a',
      idempotencyKey: 'request-child-proxy', now: new Date(now),
    });
    for (const toStatus of ['due', 'delivered'] as const) {
      await transitionMedicationFollowUp(d1, {
        lineAccountId: 'account-a', followUpId: row.id, toStatus,
        expectedVersion: row.version, actorType: 'system', actorId: 'cron',
      });
      row.version += 1;
    }
    await expect(listOwnerMedicationFollowUps(d1, 'account-a', 'friend-a'))
      .resolves.toEqual([expect.objectContaining({ id: row.id, patient_id: 'patient-child-a' })]);
    const response = await recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a', followUpId: row.id,
      response: 'concern', webhookEventId: 'proxy-child-response', now: new Date(now),
    });
    expect(response.status).toBe('concern');

    db.prepare(`UPDATE pharmacy_patient_proxy_grants
      SET revoked_at = ?, revoke_reason_code = 'user_revoked', version = version + 1, updated_at = ?
      WHERE id = 'grant-child-a'`).run(now, now);

    await expect(listOwnerMedicationFollowUps(d1, 'account-a', 'friend-a')).resolves.toEqual([]);
    await expect(getOwnerMedicationFollowUp(d1, 'account-a', 'friend-a', row.id)).resolves.toBeNull();
    await expect(recordMedicationFollowUpPatientResponse(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a', followUpId: row.id,
      response: 'concern', webhookEventId: 'proxy-child-response', now: new Date(now),
    })).rejects.toThrow(/follow-up response unavailable/i);
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
      tenant_id: 'tenant-a',
    })]);
    db.prepare(`UPDATE friends SET is_following = 0 WHERE id = 'friend-a'`).run();
    await expect(listDueMedicationFollowUps(
      d1, new Date('2026-08-22T00:00:00.000Z'),
    )).resolves.toEqual([]);
  });
});
