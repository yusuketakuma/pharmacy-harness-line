import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { listPatientTimeline } from './repository.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => SqliteDatabase;

function d1From(sqlite: SqliteDatabase): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      }),
    }),
  } as unknown as D1Database;
}

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
      CREATE TABLE pharmacy_myna_handoffs (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, friend_id TEXT NOT NULL,
        method TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_continuity_obligations (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE pharmacy_medication_followups (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL,
        patient_name TEXT, medicine_name TEXT
      );
      CREATE TABLE pharmacy_emergency_intakes (
        id TEXT PRIMARY KEY, line_account_id TEXT NOT NULL, owner_friend_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL, risk_flags_json TEXT NOT NULL
      );
    `);
    db = d1From(sqlite);
  });

  it('returns only the server-scoped owner projection without PHI or EC inference', async () => {
    const at = '2026-09-01T00:00:00.000Z';
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
    sqlite.prepare(`INSERT INTO pharmacy_myna_handoffs VALUES (?, ?, ?, ?, ?, ?)`).run(
      'myna-a', 'account-a', 'friend-a', 'E_PRESCRIPTION', 'LAUNCH_REQUESTED', at,
    );
    sqlite.prepare(`INSERT INTO pharmacy_continuity_obligations VALUES (?, ?, ?, ?, ?)`).run(
      'continuity-a', 'account-a', 'friend-a', 'active', at,
    );
    sqlite.prepare(`INSERT INTO pharmacy_medication_followups VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'followup-a', 'account-a', 'friend-a', 'future_internal_status', at,
      'PHI-PATIENT', 'PHI-FOLLOWUP-MEDICINE',
    );
    sqlite.prepare(`INSERT INTO pharmacy_emergency_intakes VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'ec-a', 'account-a', 'friend-a', 'provisional', at,
      'PHI-ENCRYPTED', '["PHI-RISK"]',
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
        domain: 'medication_follow_up', status: 'unknown', nextAction: 'open_detail',
        occurredAt: at, detailPath: '/pharmacy/medication-followup',
      },
      {
        domain: 'prescription', status: 'pending', nextAction: 'wait',
        occurredAt: at, detailPath: '/prescriptions?view=history',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /friend-|account-|patient|medicine|note|encrypted|risk|emergency|contraception|rx-a|myna-a/i,
    );
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
