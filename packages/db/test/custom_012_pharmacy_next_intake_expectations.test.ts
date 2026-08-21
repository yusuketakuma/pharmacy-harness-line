import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimDueNextIntakeExpectations,
  listAccountExpectations,
  listPatientExpectations,
  markNextIntakeExpectationReminded,
  offerNextIntakeExpectation,
  respondToNextIntakeExpectation,
} from '../../../apps/worker/src/custom/pharmacy/continuity/next-intake.js';

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

function seedContinuity(db: Database.Database, suffix: 'a' | 'b'): void {
  const now = '2026-08-18T00:00:00.000Z';
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, now, now);
  db.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`tenant-${suffix}`, `pharmacy-${suffix}`, `Tenant ${suffix}`, now, now);
  db.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`)
    .run(`tenant-${suffix}`, `account-${suffix}`, now, now);
  db.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`)
    .run(`friend-${suffix}`, `U-${suffix}`, `account-${suffix}`, now, now);
  db.prepare(`INSERT INTO pharmacy_patients
    (id, line_account_id, owner_friend_id, relationship, name, name_kana,
     birth_date, created_at, updated_at)
    VALUES (?, ?, ?, 'self', ?, ?, '1990-01-01', ?, ?)`)
    .run(`patient-${suffix}`, `account-${suffix}`, `friend-${suffix}`, suffix, suffix, now, now);
  db.prepare(`INSERT INTO pharmacy_prescription_submissions
    (id, line_account_id, friend_id, idempotency_key, status, upload_revision,
     closed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'closed', 1, ?, ?, ?)`)
    .run(`submission-${suffix}`, `account-${suffix}`, `friend-${suffix}`, `submission-key-${suffix}`, now, now, now);
  db.prepare(`INSERT INTO pharmacy_continuity_obligations
    (id, line_account_id, owner_friend_id, patient_id, source_submission_id,
     status, expected_next_from, expected_next_to, next_contact_at, consent_at,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', '2026-09-01', '2026-09-30', ?, ?, ?, ?)`)
    .run(
      `continuity-${suffix}`, `account-${suffix}`, `friend-${suffix}`,
      `patient-${suffix}`, `submission-${suffix}`, now, now, now, now,
    );
}

describe('custom_012 pharmacy next-intake expectations', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = loadDb();
    d1 = d1From(db);
    seedContinuity(db, 'a');
    seedContinuity(db, 'b');
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = CASE line_account_id
        WHEN 'account-a' THEN '["continuity"]'
        ELSE '[]'
      END
      WHERE line_account_id IN ('account-a', 'account-b')`).run();
  });

  it('stores only account-scoped timing and consent workflow state', () => {
    const columns = db.prepare('PRAGMA table_info(pharmacy_next_intake_expectations)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'obligation_id', 'line_account_id', 'owner_friend_id', 'patient_id',
      'status', 'timing_source', 'supply_days', 'expected_from', 'expected_to',
      'reminder_at', 'version',
    ]));
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'drug_name', 'disease', 'note', 'message', 'payload_json', 'line_user_id',
    ]));
  });

  it('enforces timing source and tenant ownership', () => {
    const insert = db.prepare(`INSERT INTO pharmacy_next_intake_expectations
      (id, obligation_id, line_account_id, owner_friend_id, patient_id, status,
       timing_source, supply_days, expected_from, expected_to, reminder_at,
       version, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'offered', ?, ?, '2026-09-15', '2026-09-15',
              '2026-09-15T00:00:00.000Z', 1, 'staff-a',
              '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`);

    expect(() => insert.run(
      'expectation-cross', 'continuity-a', 'account-b', 'friend-b', 'patient-b',
      'manual_supply_days', 28,
    )).toThrow(/FOREIGN KEY constraint failed/i);
    insert.run(
      'expectation-a', 'continuity-a', 'account-a', 'friend-a', 'patient-a',
      'manual_supply_days', 28,
    );
    expect(() => insert.run(
      'expectation-invalid', 'continuity-b', 'account-b', 'friend-b', 'patient-b',
      'manual_window', 28,
    )).toThrow(/CHECK constraint failed/i);
  });

  it('keeps workflow events append-only and idempotent per account', () => {
    db.prepare(`INSERT INTO pharmacy_next_intake_expectations
      (id, obligation_id, line_account_id, owner_friend_id, patient_id, status,
       timing_source, expected_from, expected_to, reminder_at, version,
       created_by, created_at, updated_at)
      VALUES ('expectation-a', 'continuity-a', 'account-a', 'friend-a', 'patient-a',
              'offered', 'manual_window', '2026-09-10', '2026-09-20',
              '2026-09-10T00:00:00.000Z', 1, 'staff-a',
              '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z')`).run();
    const insert = db.prepare(`INSERT INTO pharmacy_next_intake_expectation_events
      (id, expectation_id, line_account_id, event_type, to_status, actor_type,
       idempotency_key, occurred_at)
      VALUES (?, 'expectation-a', 'account-a', 'offered', 'offered', 'staff',
              'offer:request-a', '2026-08-18T00:00:00.000Z')`);
    insert.run('event-a');
    expect(() => insert.run('event-b')).toThrow(/UNIQUE constraint failed/i);
  });

  it('offers one pharmacist-timed expectation without inferring from an image', async () => {
    const input = {
      lineAccountId: 'account-a',
      obligationId: 'continuity-a',
      timing: { source: 'manual_supply_days' as const, supplyDays: 28 },
      staffId: 'staff-a',
      idempotencyKey: 'offer-request-a',
      now: new Date('2026-08-18T01:00:00.000Z'),
    };
    const first = await offerNextIntakeExpectation(d1, input);
    const replay = await offerNextIntakeExpectation(d1, input);
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      line_account_id: 'account-a',
      owner_friend_id: 'friend-a',
      patient_id: 'patient-a',
      status: 'offered',
      timing_source: 'manual_supply_days',
      supply_days: 28,
      expected_from: '2026-09-15',
      expected_to: '2026-09-15',
      reminder_at: '2026-09-15T00:00:00.000Z',
    });
    await expect(offerNextIntakeExpectation(d1, {
      ...input, lineAccountId: 'account-b',
    })).rejects.toThrow(/continuity record not found/i);
  });

  it('records the verified owner response once and rejects another friend', async () => {
    const item = await offerNextIntakeExpectation(d1, {
      lineAccountId: 'account-a', obligationId: 'continuity-a',
      timing: {
        source: 'manual_window', expectedFrom: '2026-09-10',
        expectedTo: '2026-09-20', reminderAt: '2026-09-10T00:00:00.000Z',
      },
      staffId: 'staff-a', idempotencyKey: 'offer-response-a',
      now: new Date('2026-08-18T01:00:00.000Z'),
    });
    const input = {
      lineAccountId: 'account-a', friendId: 'friend-a', expectationId: item.id,
      response: 'accepted' as const, idempotencyKey: 'patient-response-a',
      now: new Date('2026-08-18T02:00:00.000Z'),
    };
    const accepted = await respondToNextIntakeExpectation(d1, input);
    const replay = await respondToNextIntakeExpectation(d1, input);
    const duplicateTap = await respondToNextIntakeExpectation(d1, {
      ...input, idempotencyKey: 'patient-response-second',
    });
    expect(accepted.status).toBe('accepted');
    expect(replay).toEqual(accepted);
    expect(duplicateTap).toEqual(accepted);
    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM pharmacy_next_intake_expectation_events
      WHERE expectation_id = ? AND event_type = 'accepted'`).get(item.id)).toEqual({ count: 1 });
    await expect(respondToNextIntakeExpectation(d1, {
      ...input, friendId: 'friend-b', idempotencyKey: 'patient-response-b',
    })).rejects.toThrow(/expectation unavailable/i);
  });

  it('rejects a stale patient response after continuity is paused', async () => {
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = '["continuity"]' WHERE line_account_id = 'account-b'`).run();
    const item = await offerNextIntakeExpectation(d1, {
      lineAccountId: 'account-b', obligationId: 'continuity-b',
      timing: { source: 'manual_supply_days', supplyDays: 28 },
      staffId: 'staff-b', idempotencyKey: 'offer-paused-b',
      now: new Date('2026-08-18T01:00:00.000Z'),
    });
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = '[]' WHERE line_account_id = 'account-b'`).run();
    db.prepare("UPDATE pharmacy_continuity_obligations SET status = 'paused' WHERE id = ?")
      .run('continuity-b');

    await expect(respondToNextIntakeExpectation(d1, {
      lineAccountId: 'account-b', friendId: 'friend-b', expectationId: item.id,
      response: 'accepted', idempotencyKey: 'patient-paused-b',
      now: new Date('2026-08-18T02:00:00.000Z'),
    })).rejects.toThrow(/expectation unavailable/i);
  });

  it('claims accepted reminders once and finalizes only after delivery', async () => {
    const item = await offerNextIntakeExpectation(d1, {
      lineAccountId: 'account-a', obligationId: 'continuity-a',
      timing: {
        source: 'manual_window', expectedFrom: '2026-08-19',
        expectedTo: '2026-08-25', reminderAt: '2026-08-19T00:00:00.000Z',
      },
      staffId: 'staff-a', idempotencyKey: 'offer-due-a',
      now: new Date('2026-08-18T01:00:00.000Z'),
    });
    await respondToNextIntakeExpectation(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a', expectationId: item.id,
      response: 'accepted', idempotencyKey: 'patient-due-a',
      now: new Date('2026-08-18T02:00:00.000Z'),
    });
    await expect(claimDueNextIntakeExpectations(
      d1, new Date('2026-08-18T23:59:59.000Z'),
    )).resolves.toEqual([]);
    const claimed = await claimDueNextIntakeExpectations(
      d1, new Date('2026-08-19T00:00:00.000Z'),
    );
    expect(claimed).toEqual([expect.objectContaining({
      id: item.id, status: 'active', line_user_id: 'U-a',
      tenant_id: 'tenant-a',
    })]);
    await markNextIntakeExpectationReminded(d1, {
      lineAccountId: 'account-a', expectationId: item.id,
      expectedVersion: claimed[0].version, now: new Date('2026-08-19T00:00:01.000Z'),
    });
    await expect(markNextIntakeExpectationReminded(d1, {
      lineAccountId: 'account-a', expectationId: item.id,
      expectedVersion: claimed[0].version, now: new Date('2026-08-19T00:00:02.000Z'),
    })).resolves.toMatchObject({ id: item.id, status: 'reminded' });
    expect(db.prepare(`SELECT reminder_count
      FROM pharmacy_continuity_obligations WHERE id = ?`).get('continuity-a'))
      .toEqual({ reminder_count: 0 });
    await expect(claimDueNextIntakeExpectations(
      d1, new Date('2026-08-19T00:01:00.000Z'),
    )).resolves.toEqual([]);
  });

  it('projects linked continuity by patient, never by the family friend alone', async () => {
    const item = await offerNextIntakeExpectation(d1, {
      lineAccountId: 'account-a', obligationId: 'continuity-a',
      timing: { source: 'manual_supply_days', supplyDays: 28 },
      staffId: 'staff-a', idempotencyKey: 'offer-list-a',
      now: new Date('2026-08-18T01:00:00.000Z'),
    });
    await respondToNextIntakeExpectation(d1, {
      lineAccountId: 'account-a', friendId: 'friend-a', expectationId: item.id,
      response: 'accepted', idempotencyKey: 'patient-list-a',
      now: new Date('2026-08-18T02:00:00.000Z'),
    });
    db.prepare(`UPDATE pharmacy_continuity_obligations
      SET status = 'linked', candidate_submission_id = 'submission-a'
      WHERE id = 'continuity-a'`).run();

    await expect(listAccountExpectations(d1, 'account-a'))
      .resolves.toEqual([expect.objectContaining({ id: item.id, status: 'linked', patient_id: 'patient-a' })]);
    await expect(listPatientExpectations(d1, 'account-a', 'friend-a'))
      .resolves.toHaveLength(1);
    await expect(listPatientExpectations(d1, 'account-a', 'friend-b'))
      .resolves.toEqual([]);
    await expect(listPatientExpectations(d1, 'account-b', 'friend-a'))
      .resolves.toEqual([]);
  });
});
