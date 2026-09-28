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
const NOW = new Date('2026-08-20T00:00:00.000Z');

type RunnableStatement = D1PreparedStatement & { runSync(): D1Result };
function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() =>
      ({
        success: true,
        results: sqlite.prepare(sql).all(...values) as T[],
        meta: {},
      }) as D1Result<T>,
    raw: async <T>() =>
      sqlite
        .prepare(sql)
        .raw()
        .all(...values) as T[],
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      sqlite.transaction(() => statements.map((item) => (item as RunnableStatement).runSync() as D1Result<T>))(),
  } as unknown as D1Database;
}

const TS = '2026-08-20T00:00:00.000Z';
/** 保存期間(3年)を確実に過ぎた時刻。土台の行はこれで作り、各テストが新しいPHIを足す。 */
const OLD = '2019-01-01T00:00:00.000Z';

function seedAccount(db: Database.Database, suffix: 'a' | 'b'): void {
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `account-${suffix}`,
    `channel-${suffix}`,
    suffix,
    `token-${suffix}`,
    `secret-${suffix}`,
    TS,
    TS,
  );
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, `pharmacy-${suffix}`, suffix, TS, TS);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, TS, TS);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`).run(`friend-${suffix}`, `U-${suffix}`, `account-${suffix}`, OLD, OLD);
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, 'self', ?, ?, '1990-01-01', ?, ?)`).run(
    `patient-${suffix}`,
    `account-${suffix}`,
    `friend-${suffix}`,
    suffix,
    suffix,
    OLD,
    OLD,
  );
  db.prepare(`INSERT INTO staff_members
    (id, name, email, role, api_key, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)`).run(
    `staff-${suffix}`,
    suffix,
    `${suffix}@example.test`,
    `api-key-${suffix}`,
    TS,
    TS,
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
    `intake-${suffix}`,
    `account-${suffix}`,
    `friend-${suffix}`,
    `patient-${suffix}`,
    `intake-key-${suffix}`,
    createdAt,
    createdAt,
    createdAt,
  );
}

/** pharmacy_medication_followups を1行。FKが要求する前提行はすべて OLD で作る。 */
function seedMedicationFollowup(db: Database.Database, createdAt: string): void {
  db.prepare(`INSERT INTO pharmacy_prescription_submissions
    (id, line_account_id, friend_id, idempotency_key, status, created_at, updated_at)
    VALUES ('submission-a', 'account-a', 'friend-a', 'sub-key-a', 'closed', ?, ?)`).run(OLD, OLD);
  db.prepare(`INSERT INTO pharmacy_prescription_patients
    (submission_id, line_account_id, owner_friend_id, patient_id, intake_response_id, created_at)
    VALUES ('submission-a', 'account-a', 'friend-a', 'patient-a', 'intake-a', ?)`).run(OLD);
  db.prepare(`INSERT INTO pharmacy_medication_followups
    (id, line_account_id, owner_friend_id, patient_id, source_submission_id, status,
     due_at, created_by, created_at, updated_at)
    VALUES ('followup-a', 'account-a', 'friend-a', 'patient-a', 'submission-a', 'scheduled',
            ?, 'staff-a', ?, ?)`).run(createdAt, createdAt, createdAt);
}

/** pharmacy_myna_handoffs を1行。 */
function seedMynaHandoff(db: Database.Database, createdAt: string): void {
  db.prepare(`INSERT INTO pharmacy_myna_handoffs
    (id, line_account_id, friend_id, patient_id, method, status, source, correlation_id,
     expires_at, created_at, updated_at)
    VALUES ('handoff-a', 'account-a', 'friend-a', 'patient-a', 'E_PRESCRIPTION', 'CREATED',
            'LIFF', 'corr-a', ?, ?, ?)`).run(createdAt, createdAt, createdAt);
}

describe('custom_038 pharmacy data subject requests', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    d1 = d1From(db);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
  });

  it('stores workflow state without copying the patient PHI itself', () => {
    const columns = (
      db.prepare('PRAGMA table_info(pharmacy_data_subject_requests)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'line_account_id',
        'owner_friend_id',
        'patient_id',
        'request_type',
        'status',
        'reason',
        'legal_hold',
        'legal_hold_basis',
        'legal_hold_release_at',
        'outcome_note',
        'submitted_at',
        'identity_verified_at',
        'legal_hold_assessed_at',
        'resolved_at',
        'resolved_by',
        'version',
      ]),
    );
    expect(columns).not.toEqual(
      expect.arrayContaining(['name', 'name_kana', 'birth_date', 'answers_json', 'line_user_id']),
    );
  });

  it('rejects a request row that crosses the tenant boundary', () => {
    const insert = db.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type,
       status, reason, version, submitted_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'erasure', 'received', 'reason', 1, ?, ?, ?, ?)`);
    expect(() =>
      insert.run('request-cross', 'tenant-b', 'account-a', 'friend-a', 'patient-a', TS, 'staff-a', TS, TS),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() =>
      insert.run('request-cross-patient', 'tenant-a', 'account-a', 'friend-a', 'patient-b', TS, 'staff-a', TS, TS),
    ).toThrow(/FOREIGN KEY constraint failed/i);
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
    expect(() =>
      db.prepare("UPDATE pharmacy_data_subject_request_events SET event_type = 'resolved' WHERE id = 'event-a'").run(),
    ).toThrow(/DATA_SUBJECT_EVENT_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM pharmacy_data_subject_request_events WHERE id = 'event-a'").run()).toThrow(
      /DATA_SUBJECT_EVENT_IMMUTABLE/,
    );
  });

  it('runs the whole workflow inside one account and audits every transition', async () => {
    seedPhi(db, 'a', '2020-01-01T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'erasure',
      reason: '本人から消去の申し出',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(created).toMatchObject({
      status: 'received',
      owner_friend_id: 'friend-a',
      tenant_id: 'tenant-a',
      version: 1,
    });

    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: created.version,
      staffId: 'staff-a',
      now: NOW,
    });
    expect(verified).toMatchObject({
      status: 'identity_verified',
      identity_verified_at: NOW.toISOString(),
    });

    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: verified.version,
      staffId: 'staff-a',
      now: NOW,
    });
    expect(assessed).toMatchObject({ status: 'legal_hold_assessed', legal_hold: 0 });

    const resolved = await resolveDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: assessed.version,
      decision: 'resolved',
      outcomeNote: '保存期間経過のため消去実施',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(resolved).toMatchObject({ status: 'resolved', resolved_by: 'staff-a' });

    expect(
      db
        .prepare(`SELECT event_type FROM pharmacy_data_subject_request_events
      WHERE request_id = ? ORDER BY rowid`)
        .all(created.id),
    ).toEqual([
      { event_type: 'received' },
      { event_type: 'identity_verified' },
      { event_type: 'legal_hold_assessed' },
      { event_type: 'resolved' },
    ]);

    await expect(listDataSubjectRequests(d1, 'account-b')).resolves.toEqual([]);
    await expect(listDataSubjectRequests(d1, 'account-a')).resolves.toHaveLength(1);
  });

  it('does not resolve an erasure request before a retention assessment', async () => {
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'erasure',
      reason: '先に消去確定しない',
      staffId: 'staff-a',
      now: NOW,
    });
    await expect(
      resolveDataSubjectRequest(d1, {
        lineAccountId: 'account-a',
        requestId: created.id,
        expectedVersion: created.version,
        decision: 'resolved',
        outcomeNote: '未評価',
        staffId: 'staff-a',
        now: NOW,
      }),
    ).rejects.toThrow(/retention assessment required/i);
  });

  it('holds an erasure request whose newest PHI is still inside the 3-year period', async () => {
    seedPhi(db, 'a', '2024-08-20T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'erasure',
      reason: '消去の申し出',
      staffId: 'staff-a',
      now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: created.version,
      staffId: 'staff-a',
      now: NOW,
    });
    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: verified.version,
      staffId: 'staff-a',
      now: NOW,
    });
    expect(assessed).toMatchObject({
      status: 'legal_hold_assessed',
      legal_hold: 1,
      legal_hold_basis: 'pharmacist_law_enforcement_regulation_3y',
      legal_hold_release_at: '2027-08-20T00:00:00.000Z',
    });

    await expect(
      resolveDataSubjectRequest(d1, {
        lineAccountId: 'account-a',
        requestId: created.id,
        expectedVersion: assessed.version,
        decision: 'resolved',
        outcomeNote: '消去した',
        staffId: 'staff-a',
        now: NOW,
      }),
    ).rejects.toThrow(/legal hold/i);

    const rejected = await resolveDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: assessed.version,
      decision: 'rejected',
      outcomeNote: '法定保存期間中のため応じられない旨を説明',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(rejected).toMatchObject({ status: 'rejected' });
  });

  it('re-evaluates all sources immediately before resolving an erasure', async () => {
    seedPhi(db, 'a', '2020-01-01T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'erasure',
      reason: '再評価',
      staffId: 'staff-a',
      now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: created.version,
      staffId: 'staff-a',
      now: NOW,
    });
    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: verified.version,
      staffId: 'staff-a',
      now: NOW,
    });
    db.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
      VALUES ('intake-a-new', 'account-a', 'friend-a', 'patient-a', 2, 1, '{}', '{}',
              'intake-key-a-new', ?, ?, ?)`).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    await expect(
      resolveDataSubjectRequest(d1, {
        lineAccountId: 'account-a',
        requestId: created.id,
        expectedVersion: assessed.version,
        decision: 'resolved',
        outcomeNote: '再評価後に消去',
        staffId: 'staff-a',
        now: NOW,
      }),
    ).rejects.toThrow(/legal hold/i);
  });

  it('never blocks an access request, even while the legal hold applies', async () => {
    seedPhi(db, 'a', '2024-08-20T00:00:00.000Z');
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'access',
      reason: '開示の申し出',
      staffId: 'staff-a',
      now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: created.version,
      staffId: 'staff-a',
      now: NOW,
    });
    const assessed = await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: verified.version,
      staffId: 'staff-a',
      now: NOW,
    });
    expect(assessed.legal_hold).toBe(1);
    await expect(
      resolveDataSubjectRequest(d1, {
        lineAccountId: 'account-a',
        requestId: created.id,
        expectedVersion: assessed.version,
        decision: 'resolved',
        outcomeNote: '開示書面を交付',
        staffId: 'staff-a',
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'resolved' });
  });

  it('refuses a stale or cross-account transition', async () => {
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'correction',
      reason: '訂正の申し出',
      staffId: 'staff-a',
      now: NOW,
    });
    await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: created.version,
      staffId: 'staff-a',
      now: NOW,
    });
    await expect(
      markDataSubjectIdentityVerified(d1, {
        lineAccountId: 'account-a',
        requestId: created.id,
        expectedVersion: created.version,
        staffId: 'staff-a',
        now: NOW,
      }),
    ).rejects.toThrow(/conflict/i);
    await expect(
      markDataSubjectIdentityVerified(d1, {
        lineAccountId: 'account-b',
        requestId: created.id,
        expectedVersion: 2,
        staffId: 'staff-b',
        now: NOW,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('advances an existing exact and owner fence when another request is received', async () => {
    const first = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'erasure',
      reason: '最初の請求',
      staffId: 'staff-a',
      now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: first.id,
      expectedVersion: first.version,
      staffId: 'staff-a',
      now: NOW,
    });
    const second = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'access',
      reason: '次の請求',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(second.hold_epoch).toBeGreaterThan(verified.hold_epoch);
    expect(
      db
        .prepare(`SELECT patient_key, epoch, status FROM pharmacy_retention_hold_epochs
      WHERE line_account_id = 'account-a' ORDER BY patient_key`)
        .all(),
    ).toEqual([
      { patient_key: '*', epoch: verified.hold_epoch + 1, status: 'unknown' },
      { patient_key: 'patient-a', epoch: verified.hold_epoch + 1, status: 'unknown' },
    ]);
    expect(await listDataSubjectRequests(d1, 'account-b')).toEqual([]);
  });

  it.each([
    [4, 9],
    [9, 4],
  ])('advances the highest exact/owner epoch (%i/%i) without changing another account', async (exact, owner) => {
    const insert = db.prepare(`INSERT INTO pharmacy_retention_hold_epochs
      (tenant_id, line_account_id, owner_friend_id, patient_key, epoch, status, updated_at)
      VALUES (?, ?, ?, ?, ?, 'held', ?)`);
    insert.run('tenant-a', 'account-a', 'friend-a', 'patient-a', exact, TS);
    insert.run('tenant-a', 'account-a', 'friend-a', '*', owner, TS);
    insert.run('tenant-b', 'account-b', 'friend-b', '*', 50, TS);
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'access',
      reason: '合成の請求',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(created.hold_epoch).toBe(10);
    expect(
      db
        .prepare(`SELECT line_account_id, patient_key, epoch, status
      FROM pharmacy_retention_hold_epochs ORDER BY line_account_id, patient_key`)
        .all(),
    ).toEqual([
      { line_account_id: 'account-a', patient_key: '*', epoch: 10, status: 'unknown' },
      { line_account_id: 'account-a', patient_key: 'patient-a', epoch: 10, status: 'unknown' },
      { line_account_id: 'account-b', patient_key: '*', epoch: 50, status: 'held' },
    ]);
  });

  it('advances the shared owner fence when a request belongs to another family member', async () => {
    db.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana,
       birth_date, created_at, updated_at)
      SELECT 'patient-family', line_account_id, owner_friend_id, 'child',
             name, name_kana, birth_date, created_at, updated_at
        FROM pharmacy_patients WHERE id = 'patient-a'`).run();
    const first = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'access',
      reason: '合成の請求',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(first.hold_epoch).toBe(1);
    const second = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-family',
      requestType: 'access',
      reason: '家族の合成請求',
      staffId: 'staff-a',
      now: NOW,
    });
    expect(second.hold_epoch).toBe(2);
    expect(
      db
        .prepare(`SELECT patient_key, epoch FROM pharmacy_retention_hold_epochs
      WHERE line_account_id = 'account-a' ORDER BY patient_key`)
        .all(),
    ).toEqual([
      { patient_key: '*', epoch: 2 },
      { patient_key: 'patient-a', epoch: 1 },
      { patient_key: 'patient-family', epoch: 2 },
    ]);
  });

  it.each(['receipt', 'assessment'] as const)(
    'rejects an old resolution without changing a concurrent %s fence',
    async (stage) => {
      const first = await createDataSubjectRequest(d1, {
        lineAccountId: 'account-a',
        tenantId: 'tenant-a',
        patientId: 'patient-a',
        requestType: 'erasure',
        reason: '最初の請求',
        staffId: 'staff-a',
        now: NOW,
      });
      const verified = await markDataSubjectIdentityVerified(d1, {
        lineAccountId: 'account-a',
        requestId: first.id,
        expectedVersion: first.version,
        staffId: 'staff-a',
        now: NOW,
      });
      const assessed = await assessDataSubjectLegalHold(d1, {
        lineAccountId: 'account-a',
        requestId: first.id,
        expectedVersion: verified.version,
        staffId: 'staff-a',
        now: NOW,
      });
      expect(assessed.legal_hold).toBe(0);
      let latestEpoch = 0;
      let latestStatus = 'unknown';
      const concurrentDb = {
        prepare: d1.prepare.bind(d1),
        batch: async <T>(statements: D1PreparedStatement[]) => {
          // The first resolution already read its released assessment. A second
          // request and new PHI arrive before its guarded transition commits.
          seedPhi(db, 'a', NOW.toISOString());
          const second = await createDataSubjectRequest(d1, {
            lineAccountId: 'account-a',
            tenantId: 'tenant-a',
            patientId: 'patient-a',
            requestType: 'erasure',
            reason: '並行する請求',
            staffId: 'staff-a',
            now: NOW,
          });
          latestEpoch = second.hold_epoch;
          latestStatus = 'unknown';
          if (stage === 'assessment') {
            const secondVerified = await markDataSubjectIdentityVerified(d1, {
              lineAccountId: 'account-a',
              requestId: second.id,
              expectedVersion: second.version,
              staffId: 'staff-a',
              now: NOW,
            });
            const secondAssessed = await assessDataSubjectLegalHold(d1, {
              lineAccountId: 'account-a',
              requestId: second.id,
              expectedVersion: secondVerified.version,
              staffId: 'staff-a',
              now: NOW,
            });
            expect(secondAssessed.legal_hold).toBe(1);
            latestEpoch = secondAssessed.hold_epoch;
            latestStatus = 'held';
          }
          return d1.batch<T>(statements);
        },
      } as D1Database;
      await expect(
        resolveDataSubjectRequest(concurrentDb, {
          lineAccountId: 'account-a',
          requestId: first.id,
          expectedVersion: assessed.version,
          decision: 'resolved',
          outcomeNote: '対応済み',
          staffId: 'staff-a',
          now: NOW,
        }),
      ).rejects.toThrow(/conflict/i);
      expect(
        db.prepare(`SELECT status, version FROM pharmacy_data_subject_requests WHERE id = ?`).get(first.id),
      ).toEqual({ status: 'legal_hold_assessed', version: assessed.version });
      expect(
        db
          .prepare(`SELECT count(*) AS count FROM pharmacy_data_subject_request_events
      WHERE request_id = ? AND event_type = 'resolved'`)
          .get(first.id),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(`SELECT patient_key, epoch, status FROM pharmacy_retention_hold_epochs
      WHERE line_account_id = 'account-a' ORDER BY patient_key`)
          .all(),
      ).toEqual([
        { patient_key: '*', epoch: latestEpoch, status: latestStatus },
        { patient_key: 'patient-a', epoch: latestEpoch, status: latestStatus },
      ]);
    },
  );

  /** 消去請求を出して legal hold 判定まで進める。 */
  async function assessErasure(): Promise<{
    legal_hold: number;
    legal_hold_release_at: string | null;
  }> {
    const created = await createDataSubjectRequest(d1, {
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
      patientId: 'patient-a',
      requestType: 'erasure',
      reason: '消去の申し出',
      staffId: 'staff-a',
      now: NOW,
    });
    const verified = await markDataSubjectIdentityVerified(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: created.version,
      staffId: 'staff-a',
      now: NOW,
    });
    return await assessDataSubjectLegalHold(d1, {
      lineAccountId: 'account-a',
      requestId: created.id,
      expectedVersion: verified.version,
      staffId: 'staff-a',
      now: NOW,
    });
  }

  it('holds when the only recent PHI is a medication follow-up', async () => {
    seedPhi(db, 'a', OLD);
    seedMedicationFollowup(db, '2024-08-20T00:00:00.000Z');
    await expect(assessErasure()).resolves.toMatchObject({
      legal_hold: 1,
      legal_hold_release_at: '2027-08-20T00:00:00.000Z',
    });
  });

  it('releases the hold once the medication follow-up is also past 3 years', async () => {
    seedPhi(db, 'a', OLD);
    seedMedicationFollowup(db, '2023-08-19T00:00:00.000Z');
    // 起算日は残るが、すでに満了しているので hold は立たない。
    await expect(assessErasure()).resolves.toMatchObject({
      legal_hold: 0,
      legal_hold_release_at: '2026-08-19T00:00:00.000Z',
    });
  });

  it('holds when the only recent PHI is a myna handoff', async () => {
    seedPhi(db, 'a', OLD);
    seedMynaHandoff(db, '2025-01-01T00:00:00.000Z');
    await expect(assessErasure()).resolves.toMatchObject({
      legal_hold: 1,
      legal_hold_release_at: '2028-01-01T00:00:00.000Z',
    });
  });

  it('holds on a follow-up transition event newer than its parent row', async () => {
    seedPhi(db, 'a', OLD);
    seedMedicationFollowup(db, OLD);
    db.prepare(`INSERT INTO pharmacy_medication_followup_events
      (id, followup_id, line_account_id, event_type, actor_type, idempotency_key, occurred_at)
      VALUES ('followup-event-a', 'followup-a', 'account-a', 'escalated', 'staff',
              'followup-event-key-a', ?)`).run('2025-06-01T00:00:00.000Z');
    await expect(assessErasure()).resolves.toMatchObject({
      legal_hold: 1,
      legal_hold_release_at: '2028-06-01T00:00:00.000Z',
    });
  });

  it('refuses a request for a patient the account does not own', async () => {
    await expect(
      createDataSubjectRequest(d1, {
        lineAccountId: 'account-a',
        tenantId: 'tenant-a',
        patientId: 'patient-b',
        requestType: 'erasure',
        reason: '越境',
        staffId: 'staff-a',
        now: NOW,
      }),
    ).rejects.toThrow(/patient not found/i);
  });
});
