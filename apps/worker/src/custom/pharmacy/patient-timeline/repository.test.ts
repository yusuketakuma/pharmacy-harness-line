import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite, type TestSqliteDatabase } from '../test-sqlite.js';
import { listPatientTimeline } from './repository.js';

type SqliteDatabase = TestSqliteDatabase;
const d1From = d1FromSqlite;

describe('patient timeline repository', () => {
  let sqlite: SqliteDatabase;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.exec(`
      CREATE TABLE pharmacy_prescription_submissions (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL,
        medicine_name TEXT, staff_note TEXT
      );
      CREATE TABLE pharmacy_prescription_events (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL,
        event_type TEXT NOT NULL, to_status TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_patients (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        relationship TEXT NOT NULL, birth_date TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE pharmacy_prescription_patients (
        submission_id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL,
        owner_friend_id TEXT NOT NULL, patient_id TEXT NOT NULL
      );
      CREATE TABLE pharmacy_patient_owner_controls (
        line_account_id TEXT NOT NULL, patient_id TEXT NOT NULL,
        owner_friend_id TEXT NOT NULL, binding_suspended_at TEXT
      );
      CREATE TABLE pharmacy_patient_proxy_grants (
        line_account_id TEXT NOT NULL, patient_id TEXT NOT NULL,
        actor_friend_id TEXT NOT NULL, permission_code TEXT NOT NULL,
        revoked_at TEXT, superseded_at TEXT, expires_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_account_capabilities (
        line_account_id TEXT NOT NULL, mode TEXT NOT NULL, beta_enabled INTEGER NOT NULL
      );
      CREATE TABLE pharmacy_beta_memberships (
        line_account_id TEXT NOT NULL, participant_friend_id TEXT NOT NULL,
        subject_patient_id TEXT NOT NULL, status TEXT NOT NULL,
        starts_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_myna_handoffs (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
        patient_id TEXT, method TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_continuity_obligations (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        patient_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_medication_followups (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        patient_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        patient_name TEXT, medicine_name TEXT
      );
      CREATE TABLE pharmacy_emergency_intakes (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL, risk_flags_json TEXT NOT NULL
      );
      CREATE TABLE pharmacy_patient_intake_responses (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL,
        owner_friend_id TEXT NOT NULL, patient_id TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        answers_json TEXT NOT NULL
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY, friend_id TEXT NOT NULL, line_account_id TEXT,
        status TEXT NOT NULL, last_message_at TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO pharmacy_account_capabilities VALUES ('account-a', 'pharmacy', 0);
      INSERT INTO pharmacy_account_capabilities VALUES ('account-b', 'pharmacy', 0);
    `);
    db = d1From(sqlite);
  });

  it('returns only the server-scoped owner projection without PHI or EC inference', async () => {
    const at = '2026-09-01T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO pharmacy_patients
      VALUES ('patient-a', 'account-a', 'friend-a', 'self', '2000-01-01', NULL)`).run();
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'rx-a', 'account-a', 'friend-a', 'received', at, 'PHI-MEDICINE', 'PHI-NOTE',
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'rx-other-owner', 'account-a', 'friend-b', 'received', at, 'OTHER-MEDICINE', 'OTHER-NOTE',
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'rx-other-account', 'account-b', 'friend-a', 'received', at, 'CROSS-MEDICINE', 'CROSS-NOTE',
    );
    sqlite.prepare(`INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, patient_id, method, status, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)`).run(
      'myna-a', 'account-a', 'friend-a', 'E_PRESCRIPTION', 'LAUNCH_REQUESTED', at,
    );
    sqlite.prepare(`INSERT INTO pharmacy_continuity_obligations
      (id, line_account_id, owner_friend_id, patient_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      'continuity-a', 'account-a', 'friend-a', 'patient-a', 'active', at,
    );
    sqlite.prepare(`INSERT INTO pharmacy_medication_followups
      (id, line_account_id, owner_friend_id, patient_id, status, created_at,
       patient_name, medicine_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'followup-a', 'account-a', 'friend-a', 'patient-a', 'future_internal_status', at,
      'PHI-PATIENT', 'PHI-FOLLOWUP-MEDICINE',
    );
    sqlite.prepare(`INSERT INTO pharmacy_emergency_intakes VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'ec-a', 'account-a', 'friend-a', 'provisional', at,
      'PHI-ENCRYPTED', '["PHI-RISK"]',
    );
    sqlite.prepare(`INSERT INTO pharmacy_patient_intake_responses
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'intake-a', 'account-a', 'friend-a', 'patient-a', 1, at,
      '{"PHI-ANSWER":true}',
    );
    sqlite.prepare(`INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?)`).run(
      'chat-a', 'friend-a', 'account-a', 'in_progress', null, at,
    );
    sqlite.prepare(`INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?)`).run(
      'chat-other-owner', 'friend-b', 'account-a', 'unread', null, at,
    );

    const result = await listPatientTimeline(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    });

    expect(result).toEqual([
      {
        domain: 'continuity', status: 'in_progress', nextAction: 'open_detail',
        occurredAt: at, detailPath: '/pharmacy/continuity',
      },
      {
        domain: 'electronic_prescription', status: 'pending', nextAction: 'open_detail',
        occurredAt: at, detailPath: '/prescriptions?view=electronic',
      },
      {
        domain: 'manual_chat', status: 'in_progress', nextAction: 'wait',
        occurredAt: at, detailPath: '/pharmacy/menu',
      },
      {
        domain: 'medication_follow_up', status: 'unknown', nextAction: 'open_detail',
        occurredAt: at, detailPath: '/pharmacy/medication-followup',
      },
      {
        domain: 'patient_intake', status: 'completed', nextAction: 'none',
        occurredAt: at, detailPath: '/pharmacy/patient-intake',
      },
      {
        domain: 'prescription', status: 'pending', nextAction: 'wait',
        occurredAt: at, detailPath: '/prescriptions?view=history',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /friend-|account-|patient-a|medicine|note|encrypted|risk|emergency|contraception|rx-a|myna-a|intake-a|chat-a|chat-other/i,
    );
  });

  it('hides linked patient timeline items after proxy revoke', async () => {
    const at = '2026-09-01T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO pharmacy_patients
      VALUES ('patient-child', 'account-a', 'friend-a', 'child', '2018-01-01', NULL)`).run();
    sqlite.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (line_account_id, patient_id, actor_friend_id, permission_code,
       revoked_at, superseded_at, expires_at)
      VALUES ('account-a', 'patient-child', 'friend-a', 'patient_intake_v1',
              NULL, NULL, '2099-01-01T00:00:00.000Z')`).run();
    sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      VALUES ('rx-child', 'account-a', 'friend-a', 'received', ?, NULL, NULL)`).run(at);
    sqlite.prepare(`INSERT INTO pharmacy_prescription_patients
      VALUES ('rx-child', 'account-a', 'friend-a', 'patient-child')`).run();
    sqlite.prepare(`INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, patient_id, method, status, created_at)
      VALUES ('myna-child', 'account-a', 'friend-a', 'patient-child',
              'E_PRESCRIPTION', 'LAUNCH_REQUESTED', ?)`).run(at);
    sqlite.prepare(`INSERT INTO pharmacy_continuity_obligations
      (id, line_account_id, owner_friend_id, patient_id, status, created_at)
      VALUES ('continuity-child', 'account-a', 'friend-a', 'patient-child', 'active', ?)`).run(at);
    sqlite.prepare(`INSERT INTO pharmacy_medication_followups
      (id, line_account_id, owner_friend_id, patient_id, status, created_at,
       patient_name, medicine_name)
      VALUES ('followup-child', 'account-a', 'friend-a', 'patient-child',
              'delivered', ?, 'hidden', 'hidden')`).run(at);

    await expect(listPatientTimeline(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    })).resolves.toHaveLength(4);

    sqlite.prepare(`UPDATE pharmacy_patient_proxy_grants
      SET revoked_at = ?`).run(at);

    await expect(listPatientTimeline(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    })).resolves.toEqual([]);
  });

  it('returns one deterministic bounded page', async () => {
    const insert = sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 60; index += 1) {
      insert.run(
        `rx-${String(index).padStart(2, '0')}`,
        'account-a',
        'friend-a',
        'closed',
        '2026-09-01T00:00:00.000Z',
        null,
        null,
      );
    }

    const first = await listPatientTimeline(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    });
    const second = await listPatientTimeline(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    });

    expect(first).toHaveLength(50);
    expect(second).toEqual(first);
  });

  it('keeps an old actionable prescription visible by its current status event time', async () => {
    const insert = sqlite.prepare(`INSERT INTO pharmacy_prescription_submissions
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      'old-ready', 'account-a', 'friend-a', 'ready',
      '2025-01-01T00:00:00.000Z', null, null,
    );
    sqlite.prepare(`INSERT INTO pharmacy_prescription_events
      VALUES (?, ?, ?, ?, ?)`).run(
      'ready-event', 'old-ready', 'status_changed', 'ready', '2026-09-01T00:00:00.000Z',
    );
    for (let index = 0; index < 50; index += 1) {
      insert.run(
        `recent-closed-${index}`, 'account-a', 'friend-a', 'closed',
        '2026-08-01T00:00:00.000Z', null, null,
      );
    }

    const result = await listPatientTimeline(db, {
      lineAccountId: 'account-a', friendId: 'friend-a',
    });

    expect(result[0]).toMatchObject({
      domain: 'prescription', status: 'action_required',
      occurredAt: '2026-09-01T00:00:00.000Z',
    });
  });
});
