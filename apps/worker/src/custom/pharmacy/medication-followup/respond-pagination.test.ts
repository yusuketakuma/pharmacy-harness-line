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
const mocks = vi.hoisted(() => ({ verify: vi.fn(), resolve: vi.fn(), capability: vi.fn() }));
vi.mock('../../../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verify }));
vi.mock('../prescriptions/patient.js', () => ({ resolvePrescriptionPatient: mocks.resolve }));
vi.mock('../growth-loop/access.js', () => ({
  canAccessPharmacyAccount: vi.fn(),
  hasPharmacyCapability: mocks.capability,
}));

import { medicationFollowUpRoutes } from './routes.js';

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
    name TEXT NOT NULL
  );
  CREATE TABLE pharmacy_medication_followups (
    id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
    patient_id TEXT NOT NULL, source_submission_id TEXT NOT NULL, status TEXT NOT NULL,
    due_at TEXT NOT NULL, delivered_at TEXT, responded_at TEXT, assigned_to TEXT,
    closed_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE pharmacy_medication_followup_events (
    id TEXT PRIMARY KEY, followup_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
    event_type TEXT NOT NULL, from_status TEXT, to_status TEXT, actor_type TEXT NOT NULL,
    actor_id TEXT, idempotency_key TEXT NOT NULL, occurred_at TEXT NOT NULL,
    UNIQUE (line_account_id, idempotency_key)
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

    ({ db, close } = database());
    await db.prepare(
      `INSERT INTO pharmacy_patients (id, line_account_id, owner_friend_id, name)
       VALUES (?, ?, ?, ?)`,
    ).bind(PATIENT_ID, LINE_ACCOUNT_ID, FRIEND_ID, '田中 太郎').run();

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
});
