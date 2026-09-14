import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression for a false 409: the respond route used to confirm a successful
// write by re-deriving it from listOwnerMedicationFollowUps, which is capped
// at the 20 most-recently-created rows. A patient with more than 20
// follow-up rows on record (realistic for recurring medications over the
// product's 3-year PHI retention window) could respond successfully in the
// DB yet still be told the save failed. This drives the real repository SQL
// against an in-memory sqlite DB — the mocked routes.test.ts cannot exercise
// the LIMIT 20 boundary since it mocks ./repository.js entirely.
const mocks = vi.hoisted(() => ({
  verify: vi.fn(), resolve: vi.fn(), capability: vi.fn(), betaParticipant: vi.fn(),
  betaSchemaState: vi.fn(),
}));
vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('../growth-loop/access.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../growth-loop/access.js')>(),
  canAccessPharmacyAccount: vi.fn(),
  hasPharmacyCapability: mocks.capability,
}));
vi.mock('../beta-membership/repository.js', () => ({
  canUsePharmacyBetaParticipant: mocks.betaParticipant,
  getPharmacyBetaSchemaState: mocks.betaSchemaState,
}));

import { medicationFollowUpRoutes } from './routes.js';
import {
  recordMedicationFollowUpContact,
  transitionMedicationFollowUp,
} from './repository.js';

const require = createRequire(import.meta.url);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      reader: boolean;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
      run(...values: unknown[]): { changes: number };
    };
    transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
    close(): void;
  };

// Only the columns the patient-response path touches; the production schema
// lives in packages/db/migrations/custom_011_pharmacy_medication_followups.sql.
const SCHEMA = `
  CREATE TABLE pharmacy_patients (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
    name TEXT NOT NULL, relationship TEXT NOT NULL DEFAULT 'self',
    birth_date TEXT NOT NULL DEFAULT '1990-01-01', archived_at TEXT
  );
  CREATE TABLE pharmacy_patient_owner_controls (
    line_account_id TEXT NOT NULL, patient_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
    binding_suspended_at TEXT
  );
  CREATE TABLE pharmacy_patient_proxy_grants (
    line_account_id TEXT NOT NULL, patient_id TEXT NOT NULL, actor_friend_id TEXT NOT NULL,
    permission_code TEXT NOT NULL, revoked_at TEXT, superseded_at TEXT, expires_at TEXT
  );
  CREATE TABLE pharmacy_account_capabilities (
    line_account_id TEXT NOT NULL, mode TEXT NOT NULL, beta_enabled INTEGER NOT NULL
  );
  CREATE TABLE pharmacy_beta_memberships (
    line_account_id TEXT NOT NULL, participant_friend_id TEXT NOT NULL,
    subject_patient_id TEXT NOT NULL, status TEXT NOT NULL,
    starts_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
  CREATE TABLE line_accounts (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE tenant_line_accounts (tenant_id TEXT NOT NULL, line_account_id TEXT NOT NULL);
  CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE staff_members (
    id TEXT PRIMARY KEY, principal_kind TEXT NOT NULL DEFAULT 'human',
    shared_tenant_id TEXT, is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE tenant_staff_memberships (
    tenant_id TEXT NOT NULL, staff_id TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE pharmacy_staff_accounts (
    line_account_id TEXT NOT NULL, staff_id TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE pharmacy_medication_followups (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
    patient_id TEXT NOT NULL, source_submission_id TEXT NOT NULL, status TEXT NOT NULL,
    due_at TEXT NOT NULL, question_set_version INTEGER NOT NULL DEFAULT 1,
    response_deadline_at TEXT, delivered_at TEXT, responded_at TEXT, assigned_to TEXT,
    closed_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_medication_followup_events (
    id TEXT PRIMARY KEY, followup_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    event_type TEXT NOT NULL, from_status TEXT, to_status TEXT, actor_type TEXT NOT NULL,
    actor_id TEXT, idempotency_key TEXT NOT NULL, occurred_at TEXT NOT NULL,
    assignee_staff_id TEXT,
    UNIQUE (line_account_id, idempotency_key)
  );
  CREATE TABLE pharmacy_medication_followup_contact_records (
    id TEXT PRIMARY KEY, followup_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    channel TEXT NOT NULL, outcome_code TEXT NOT NULL, next_contact_at TEXT,
    actor_staff_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
`;

function database() {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(SCHEMA);
  type Statement = { sql: string; values: unknown[] };
  const exec = ({ sql, values }: Statement) => {
    const prepared = sqlite.prepare(sql);
    if (prepared.reader) {
      return { success: true, results: prepared.all(...values), meta: { changes: 0 } };
    }
    return { success: true, results: [], meta: { changes: prepared.run(...values).changes } };
  };
  const statement = (sql: string, values: unknown[] = []) => ({
    sql,
    values,
    bind(...next: unknown[]) { return statement(sql, next); },
    async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
    async all<T>() {
      return { success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {} };
    },
    async run() { return exec({ sql, values }); },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (items: Statement[]) =>
      sqlite.transaction((batch: Statement[]) => batch.map(exec))(items),
  } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}

function app() {
  const root = new Hono<any>();
  root.route('/', medicationFollowUpRoutes);
  return root;
}

const LINE_ACCOUNT_ID = 'account-a';
const FRIEND_ID = 'friend-a';
const PATIENT_ID = 'patient-a';
const TARGET_ID = 'followup-oldest';

describe('medication follow-up respond confirmation beyond the recent-20 window', () => {
  let db: D1Database;
  let close: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue({
      lineUserId: 'U-a', loginChannelId: 'login-a', tenantId: 'tenant-a',
      lineAccountId: LINE_ACCOUNT_ID,
    });
    mocks.resolve.mockResolvedValue({ lineAccountId: LINE_ACCOUNT_ID, friendId: FRIEND_ID });
    mocks.capability.mockResolvedValue(true);
    mocks.betaParticipant.mockResolvedValue(true);
    mocks.betaSchemaState.mockResolvedValue('ready');

    ({ db, close } = database());
    await db.prepare(
      `INSERT INTO pharmacy_account_capabilities VALUES (?, 'pharmacy', 0)`,
    ).bind(LINE_ACCOUNT_ID).run();
    await db.prepare(
      `INSERT INTO pharmacy_patients (id, line_account_id, owner_friend_id, name)
       VALUES (?, ?, ?, ?)`,
    ).bind(PATIENT_ID, LINE_ACCOUNT_ID, FRIEND_ID, '田中 太郎').run();
    await db.prepare(`INSERT INTO line_accounts (id) VALUES (?)`).bind(LINE_ACCOUNT_ID).run();
    await db.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES ('tenant-a', ?)`).bind(LINE_ACCOUNT_ID).run();
    await db.prepare(`INSERT INTO tenants (id, status) VALUES ('tenant-a', 'active')`).run();
    await db.prepare(
      `INSERT INTO staff_members (id, principal_kind, shared_tenant_id) VALUES ('staff-a', 'human', NULL), ('staff-b', 'human', NULL)`,
    ).run();
    await db.prepare(
      `INSERT INTO tenant_staff_memberships (tenant_id, staff_id) VALUES ('tenant-a', 'staff-a'), ('tenant-a', 'staff-b')`,
    ).run();
    await db.prepare(
      `INSERT INTO pharmacy_staff_accounts (line_account_id, staff_id) VALUES (?, 'staff-a')`,
    ).bind(LINE_ACCOUNT_ID).run();

    // The row we will respond to: oldest by created_at, so it sits outside
    // the ORDER BY created_at DESC LIMIT 20 window once 20 newer rows exist.
    await db.prepare(
      `INSERT INTO pharmacy_medication_followups
        (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
         status, due_at, version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'delivered', ?, 1, 'staff-a', ?, ?)`,
    ).bind(
      TARGET_ID, LINE_ACCOUNT_ID, FRIEND_ID, PATIENT_ID, 'submission-oldest',
      '2020-01-01T09:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
    ).run();

    // 20 more-recently-created rows for the same owner, pushing the target
    // row out of listOwnerMedicationFollowUps's top-20.
    for (let i = 0; i < 20; i += 1) {
      const createdAt = `2026-08-1${String(i).padStart(2, '0')}T00:00:00.000Z`;
      await db.prepare(
        `INSERT INTO pharmacy_medication_followups
          (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
           status, due_at, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, 1, 'staff-a', ?, ?)`,
      ).bind(
        `followup-recent-${i}`, LINE_ACCOUNT_ID, FRIEND_ID, PATIENT_ID, `submission-recent-${i}`,
        '2099-01-01T09:00:00.000Z', createdAt, createdAt,
      ).run();
    }
  });

  it('confirms the write with a 200 instead of a false 409', async () => {
    const response = await app().request(
      `/api/liff/pharmacy/medication-followups/${TARGET_ID}/respond?liffId=liff-a`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer id-token-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: 'no_issue', expectedVersion: 1, idempotencyKey: 'response-oldest',
        }),
      },
      { DB: db },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      followUp: {
        id: TARGET_ID, patient_name: '田中 太郎', status: 'no_issue', version: 2,
      },
    });
    close();
  });

  it('stays correct on idempotent replay of the same request', async () => {
    const path = `/api/liff/pharmacy/medication-followups/${TARGET_ID}/respond?liffId=liff-a`;
    const init = {
      method: 'POST',
      headers: { Authorization: 'Bearer id-token-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response: 'no_issue', expectedVersion: 1, idempotencyKey: 'response-oldest-replay',
      }),
    };
    const first = await app().request(path, init, { DB: db });
    expect(first.status).toBe(200);

    const replay = await app().request(path, init, { DB: db });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      followUp: { id: TARGET_ID, status: 'no_issue', version: 2 },
    });
    close();
  });

  it('treats an omitted assignee as null during assigned-transition replay', async () => {
    await db.prepare(
      `UPDATE pharmacy_medication_followups SET status = 'concern' WHERE id = ?`,
    ).bind(TARGET_ID).run();
    const input = {
      lineAccountId: LINE_ACCOUNT_ID,
      followUpId: TARGET_ID,
      toStatus: 'assigned' as const,
      expectedVersion: 1,
      actorType: 'staff' as const,
      actorId: 'staff-a',
      idempotencyKey: 'assigned-replay-key',
      now: new Date('2026-09-14T00:00:00.000Z'),
    };

    const first = await transitionMedicationFollowUp(db, input);
    const replay = await transitionMedicationFollowUp(db, input);

    expect(first).toMatchObject({ status: 'assigned', version: 2 });
    expect(replay).toMatchObject({ status: 'assigned', version: 2 });
    await expect(db.prepare(
      `SELECT assignee_staff_id FROM pharmacy_medication_followup_events
        WHERE idempotency_key = ?`,
    ).bind(input.idempotencyKey).first<{ assignee_staff_id: string | null }>())
      .resolves.toMatchObject({ assignee_staff_id: null });
    close();
  });

  it('allows an identical contact replay after its follow-up time has passed', async () => {
    const first = await recordMedicationFollowUpContact(db, {
      lineAccountId: LINE_ACCOUNT_ID,
      followUpId: TARGET_ID,
      channel: 'phone',
      outcomeCode: 'answered',
      actorStaffId: 'staff-a',
      idempotencyKey: 'contact-replay-key',
      expectedVersion: 1,
      now: new Date('2026-09-14T00:00:00.000Z'),
    });
    const replay = await recordMedicationFollowUpContact(db, {
      lineAccountId: LINE_ACCOUNT_ID,
      followUpId: TARGET_ID,
      channel: 'phone',
      outcomeCode: 'answered',
      actorStaffId: 'staff-a',
      idempotencyKey: 'contact-replay-key',
      expectedVersion: 1,
      now: new Date('2026-09-15T00:00:00.000Z'),
    });

    expect(replay.id).toBe(first.id);
    close();
  });

  it('does not write a contact when the explicit assignee is not authorized', async () => {
    await db.prepare(
      `UPDATE pharmacy_medication_followups SET status = 'concern' WHERE id = ?`,
    ).bind(TARGET_ID).run();

    await expect(transitionMedicationFollowUp(db, {
      lineAccountId: LINE_ACCOUNT_ID,
      followUpId: TARGET_ID,
      toStatus: 'assigned',
      expectedVersion: 1,
      actorType: 'staff',
      actorId: 'staff-a',
      assigneeStaffId: 'staff-b',
      idempotencyKey: 'unauthorized-assignee-key',
      contact: {
        channel: 'phone', outcomeCode: 'answered', idempotencyKey: 'unauthorized-contact-key',
      },
      now: new Date('2026-09-14T00:00:00.000Z'),
    })).rejects.toThrow('transition conflict');

    await expect(db.prepare(
      `SELECT status, version FROM pharmacy_medication_followups WHERE id = ?`,
    ).bind(TARGET_ID).first<{ status: string; version: number }>())
      .resolves.toMatchObject({ status: 'concern', version: 1 });
    await expect(db.prepare(
      `SELECT COUNT(*) AS count FROM pharmacy_medication_followup_contact_records
        WHERE idempotency_key = ?`,
    ).bind('unauthorized-contact-key').first<{ count: number }>())
      .resolves.toMatchObject({ count: 0 });
    close();
  });
});
