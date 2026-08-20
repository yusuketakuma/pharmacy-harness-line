import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessDataSubjectLegalHold,
  createDataSubjectRequest,
  listDataSubjectRequests,
  markDataSubjectIdentityVerified,
  resolveDataSubjectRequest,
} from '../../../apps/worker/src/custom/pharmacy/data-subject-requests/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_038_pharmacy_data_subject_requests.sql');
const NOW = new Date('2026-08-20T00:00:00.000Z');

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

const TS = '2026-08-20T00:00:00.000Z';

function seedAccount(db: Database.Database, suffix: 'a' | 'b'): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, TS, TS,
  );
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, `pharmacy-${suffix}`, suffix, TS, TS);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, TS, TS);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`).run(`friend-${suffix}`, `U-${suffix}`, `account-${suffix}`, TS, TS);
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, 'self', ?, ?, '1990-01-01', ?, ?)`).run(
    `patient-${suffix}`, `account-${suffix}`, `friend-${suffix}`, suffix, suffix, TS, TS,
  );
  db.prepare(`INSERT INTO staff_members
    (id, name, email, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)`).run(
    `staff-${suffix}`, suffix, `${suffix}@example.test`, `api-key-${suffix}`, TS, TS,
  );
  db.prepare(`INSERT INTO tenant_staff_memberships
    (tenant_id, staff_id, role, is_active, created_at, updated_at)
    VALUES (?, ?, 'admin', 1, ?, ?)`).run(`tenant-${suffix}`, `staff-${suffix}`, TS, TS);
  db.prepare(`INSERT INTO pharmacy_staff_accounts
    (line_account_id, staff_id, is_active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, TS, TS);
}

/** Records one PHI row (an intake response) for the patient at `createdAt`. */
function seedPhi(db: Database.Database, suffix: 'a' | 'b', createdAt: string): void {
  db.prepare(`INSERT INTO pharmacy_patient_intake_responses
    (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
     patient_snapshot_json, answers_json, idempotency_key,
     representative_consent_at, privacy_consent_at, created_at)
    VALUES (?, ?, ?, ?, 1, 1, '{}', '{}', ?, ?, ?, ?)`).run(
    `intake-${suffix}`, `account-${suffix}`, `friend-${suffix}`, `patient-${suffix}`,
    `intake-key-${suffix}`, createdAt, createdAt, createdAt,
  );
}

describe('custom_038 pharmacy data subject requests', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(readFileSync(MIGRATION, 'utf8'));
    d1 = d1From(db);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
  });

  it('stores workflow state without copying the patient PHI itself', () => {
    const columns = (db.prepare('PRAGMA table_info(pharmacy_data_subject_requests)')
      .all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'tenant_id', 'line_account_id', 'owner_friend_id', 'patient_id', 'request_type',
      'status', 'reason', 'legal_hold', 'legal_hold_basis', 'legal_hold_release_at',
      'outcome_note', 'submitted_at', 'identity_verified_at', 'legal_hold_assessed_at',
      'resolved_at', 'resolved_by', 'version',
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      'name', 'name_kana', 'birth_date', 'answers_json', 'line_user_id',
    ]));
  });

  it('rejects a request row that crosses the tenant boundary', () => {
    const insert = db.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
       status, reason, version, submitted_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'erasure', 'received', 'reason', 1, ?, ?, ?, ?)`);
    expect(() => insert.run(
      'request-cross', 'tenant-b', 'account-a', 'friend-a', 'patient-a', TS, 'staff-a', TS, TS,
    )).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => insert.run(
      'request-cross-patient', 'tenant-a', 'account-a', 'friend-a', 'patient-b', TS, 'staff-a', TS, TS,
    )).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('keeps the audit trail append-only', () => {
    db.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
       status, reason, version, submitted_at, created_by, created_at, updated_at)
      VALUES ('request-a', 'tenant-a', 'account-a', 'friend-a', 'patient-a', 'access',
              'received', 'reason', 1, ?, 'staff-a', ?, ?)`).run(TS, TS, TS);
    db.prepare(`INSERT INTO pharmacy_data_subject_request_events
      (id, request_id, line_account_id, event_type, actor_staff_id, occurred_at)
      VALUES ('event-a', 'request-a', 'account-a', 'received', 'staff-a', ?)`).run(TS);
    expect(() => db.prepare(
      "UPDATE pharmacy_data_subject_request_events SET event_type = 'resolved' WHERE id = 'event-a'",
    ).run()).toThrow(/DATA_SUBJECT_EVENT_IMMUTABLE/);
    expect(() => db.prepare(
      "DELETE FROM pharmacy_data_subject_request_events WHERE id = 'event-a'",
    ).run()).toThrow(/DATA_SUBJECT_EVENT_IMMUTABLE/);
  });

  it('runs the whole workflow inside one account and audits every transition', async () => {
    seedPhi(db, 'a', '2020-01-01T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a', tenantId: 'tenant-a', patientId: 'patient-a',
      requestType: 'erasure', reason: '本人から消去の申し出', staffId: 'staff-a', now: NOW,
    });
    expect(created).toMatchObject({
      status: 'received', owner_friend_id: 'friend-a', tenant_id: 'tenant-a', version: 1,
    });

    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: created.version, staffId: 'staff-a', now: NOW,
    });
    expect(verified).toMatchObject({ status: 'identity_verified', identity_verified_at: NOW.toISOString() });

    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: verified.version, staffId: 'staff-a', now: NOW,
    });
    expect(assessed).toMatchObject({ status: 'legal_hold_assessed', legal_hold: 0 });

    const resolved = await resolveDataSubjectRequest(d1, {
      lineAccountId: 'account-a', requestId: created.id, expectedVersion: assessed.version,
      decision: 'resolved', outcomeNote: '保存期間経過のため消去実施', staffId: 'staff-a', now: NOW,
    });
    expect(resolved).toMatchObject({ status: 'resolved', resolved_by: 'staff-a' });

    expect(db.prepare(`SELECT event_type FROM pharmacy_data_subject_request_events
      WHERE request_id = ? ORDER BY rowid`).all(created.id))
      .toEqual([
        { event_type: 'received' }, { event_type: 'identity_verified' },
        { event_type: 'legal_hold_assessed' }, { event_type: 'resolved' },
      ]);

    await expect(listDataSubjectRequests(d1, 'account-b')).resolves.toEqual([]);
    await expect(listDataSubjectRequests(d1, 'account-a')).resolves.toHaveLength(1);
  });

  it('holds an erasure request whose newest PHI is still inside the 3-year period', async () => {
    seedPhi(db, 'a', '2024-08-20T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a', tenantId: 'tenant-a', patientId: 'patient-a',
      requestType: 'erasure', reason: '消去の申し出', staffId: 'staff-a', now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: created.version, staffId: 'staff-a', now: NOW,
    });
    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: verified.version, staffId: 'staff-a', now: NOW,
    });
    expect(assessed).toMatchObject({
      status: 'legal_hold_assessed', legal_hold: 1,
      legal_hold_basis: 'pharmacist_law_enforcement_regulation_3y',
      legal_hold_release_at: '2027-08-20T00:00:00.000Z',
    });

    await expect(resolveDataSubjectRequest(d1, {
      lineAccountId: 'account-a', requestId: created.id, expectedVersion: assessed.version,
      decision: 'resolved', outcomeNote: '消去した', staffId: 'staff-a', now: NOW,
    })).rejects.toThrow(/legal hold/i);

    const rejected = await resolveDataSubjectRequest(d1, {
      lineAccountId: 'account-a', requestId: created.id, expectedVersion: assessed.version,
      decision: 'rejected', outcomeNote: '法定保存期間中のため応じられない旨を説明',
      staffId: 'staff-a', now: NOW,
    });
    expect(rejected).toMatchObject({ status: 'rejected' });
  });

  it('never blocks an access request, even while the legal hold applies', async () => {
    seedPhi(db, 'a', '2024-08-20T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a', tenantId: 'tenant-a', patientId: 'patient-a',
      requestType: 'access', reason: '開示の申し出', staffId: 'staff-a', now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: created.version, staffId: 'staff-a', now: NOW,
    });
    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: verified.version, staffId: 'staff-a', now: NOW,
    });
    expect(assessed.legal_hold).toBe(1);
    await expect(resolveDataSubjectRequest(d1, {
      lineAccountId: 'account-a', requestId: created.id, expectedVersion: assessed.version,
      decision: 'resolved', outcomeNote: '開示書面を交付', staffId: 'staff-a', now: NOW,
    })).resolves.toMatchObject({ status: 'resolved' });
  });

  it('refuses a stale or cross-account transition', async () => {
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a', tenantId: 'tenant-a', patientId: 'patient-a',
      requestType: 'correction', reason: '訂正の申し出', staffId: 'staff-a', now: NOW,
    });
    await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: created.version, staffId: 'staff-a', now: NOW,
    });
    await expect(markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a', requestId: created.id,
      expectedVersion: created.version, staffId: 'staff-a', now: NOW,
    })).rejects.toThrow(/conflict/i);
    await expect(markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-b', requestId: created.id,
      expectedVersion: 2, staffId: 'staff-b', now: NOW,
    })).rejects.toThrow(/not found/i);
  });

  it('refuses a request for a patient the account does not own', async () => {
    await expect(createDataSubjectRequest(d1, {
      lineAccountId: 'account-a', tenantId: 'tenant-a', patientId: 'patient-b',
      requestType: 'erasure', reason: '越境', staffId: 'staff-a', now: NOW,
    })).rejects.toThrow(/patient not found/i);
  });
});
