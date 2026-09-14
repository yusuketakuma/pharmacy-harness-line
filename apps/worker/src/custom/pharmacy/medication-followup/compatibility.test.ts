import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  listOwnerMedicationFollowUps,
  listPatientMedicationFollowUps,
  transitionMedicationFollowUp,
} from './repository.js';

type SqliteDatabase = {
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): { changes: number };
  };
  exec(sql: string): void;
  transaction<T>(
    callback: (items: Array<{ execute?: () => unknown }>) => T,
  ): (items: Array<{ execute?: () => unknown }>) => T;
  close(): void;
};

const require = createRequire(import.meta.url);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => SqliteDatabase;

function oldSchemaDb(): { db: D1Database; close: () => void } {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(`
    CREATE TABLE pharmacy_medication_followups (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      owner_friend_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      source_submission_id TEXT NOT NULL,
      status TEXT NOT NULL,
      due_at TEXT NOT NULL,
      delivered_at TEXT,
      responded_at TEXT,
      assigned_to TEXT,
      closed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE pharmacy_patients (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      owner_friend_id TEXT NOT NULL,
      name TEXT NOT NULL,
      relationship TEXT NOT NULL,
      birth_date TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE pharmacy_patient_owner_controls (
      line_account_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      owner_friend_id TEXT NOT NULL,
      binding_suspended_at TEXT,
      PRIMARY KEY (line_account_id, patient_id, owner_friend_id)
    );
    CREATE TABLE pharmacy_patient_proxy_grants (
      line_account_id TEXT NOT NULL,
      patient_id TEXT NOT NULL,
      actor_friend_id TEXT NOT NULL,
      permission_code TEXT NOT NULL,
      revoked_at TEXT,
      superseded_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE pharmacy_medication_followup_events (
      id TEXT PRIMARY KEY,
      followup_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      idempotency_key TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE tenant_line_accounts (tenant_id TEXT NOT NULL, line_account_id TEXT NOT NULL);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE staff_members (
      id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tenant_staff_memberships (
      tenant_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE pharmacy_staff_accounts (
      line_account_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, name, relationship, birth_date)
    VALUES ('patient-a', 'account-a', 'friend-a', '田中 太郎', 'self', '1990-01-01');
    INSERT INTO pharmacy_medication_followups
      (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
       status, due_at, created_by, created_at, updated_at)
    VALUES ('followup-old', 'account-a', 'friend-a', 'patient-a', 'submission-a',
            'delivered', '2026-09-15T09:00:00.000Z', 'staff-a',
            '2026-09-14T09:00:00.000Z', '2026-09-14T09:00:00.000Z');
  `);
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bound = (values: unknown[]) => ({
        async all<T>() {
          return { success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {} };
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, results: [], meta: { changes: result.changes } };
        },
        execute: () => {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, results: [], meta: { changes: result.changes } };
        },
      });
      return {
        async all<T>() {
          return { success: true, results: statement.all() as T[], meta: {} };
        },
        first<T>() { return Promise.resolve((statement.get() as T | undefined) ?? null); },
        run() {
          const result = statement.run();
          return Promise.resolve({ success: true, results: [], meta: { changes: result.changes } });
        },
        bind(...values: unknown[]) { return bound(values); },
      };
    },
    batch: async (statements: Array<{ execute?: () => unknown }>) =>
      sqlite.transaction((items: Array<{ execute?: () => unknown }>) =>
        items.map((item) => item.execute?.()))(statements),
  } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}

describe('medication follow-up additive schema compatibility', () => {
  it('keeps patient reads available before the closure migration is applied', async () => {
    const { db, close } = oldSchemaDb();
    try {
      const rows = await listPatientMedicationFollowUps(db, 'account-a', 'patient-a');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'followup-old',
        question_set_version: 1,
        response_deadline_at: null,
      });
    } finally {
      close();
    }
  });

  it('keeps owner-scoped reads available before the membership migration is applied', async () => {
    const { db, close } = oldSchemaDb();
    try {
      const rows = await listOwnerMedicationFollowUps(db, 'account-a', 'friend-a');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'followup-old', patient_name: '田中 太郎' });
    } finally {
      close();
    }
  });

  it('keeps non-closure state transitions available before the closure migration is applied', async () => {
    const { db, close } = oldSchemaDb();
    try {
      const saved = await transitionMedicationFollowUp(db, {
        lineAccountId: 'account-a',
        followUpId: 'followup-old',
        toStatus: 'no_issue',
        expectedVersion: 1,
        actorType: 'system',
        actorId: 'legacy-cron',
        idempotencyKey: 'legacy-no-issue',
      });
      expect(saved).toMatchObject({ id: 'followup-old', status: 'no_issue', version: 2 });
    } finally {
      close();
    }
  });

  it('stops response-record transitions until the closure migration is applied', async () => {
    const { db, close } = oldSchemaDb();
    try {
      await db.prepare(
        `UPDATE pharmacy_medication_followups SET status = 'assigned', version = 2 WHERE id = ?`,
      ).bind('followup-old').run();
      await expect(transitionMedicationFollowUp(db, {
        lineAccountId: 'account-a',
        followUpId: 'followup-old',
        toStatus: 'responded',
        expectedVersion: 2,
        actorType: 'system',
        actorId: 'legacy-cron',
        idempotencyKey: 'legacy-responded',
      })).rejects.toThrow('closure unavailable');
    } finally {
      close();
    }
  });
});
