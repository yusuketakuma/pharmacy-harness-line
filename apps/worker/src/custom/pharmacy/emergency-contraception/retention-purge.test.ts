import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'vitest';

import { purgeEmergencyIntakesPastRetention } from './retention-purge.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type Sqlite3Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

type RunnableStatement = {
  bind(...next: unknown[]): RunnableStatement;
  first(): Promise<unknown>;
  all(): Promise<{ success: true; results: unknown[]; meta: Record<string, never> }>;
  run(): Promise<{ success: true; meta: { changes: number }; results: never[] }>;
  runSync(): { success: true; meta: { changes: number }; results: never[] };
};

/** Adapts better-sqlite3 to the D1 surface the worker uses, including batch(). */
function d1From(sqlite: Sqlite3Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): RunnableStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => statement(sql, values).runSync(),
    runSync: () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: RunnableStatement[]) => sqlite.transaction(() =>
      statements.map((item) => item.runSync()),
    )(),
  } as unknown as D1Database;
}

const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('emergency contraception retention purge (NEXT-2)', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;

  function seedAccount(suffix: 'a' | 'b', retentionDays: number): void {
    const now = '2026-01-01T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, now, now,
    );
    sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)`).run(`tenant-${suffix}`, suffix, suffix, now, now);
    sqlite.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)`).run(`tenant-${suffix}`, `account-${suffix}`, now, now);
    sqlite.prepare(`INSERT INTO friends
      (id, line_user_id, provider_line_user_id, line_account_id, is_following, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`).run(
      `friend-${suffix}`, `legacy-u-${suffix}`, `U-${suffix}`, `account-${suffix}`, now, now,
    );
    sqlite.prepare(`INSERT INTO staff_members
      (id, name, role, api_key, is_active, created_at, updated_at)
      VALUES (?, ?, 'admin', ?, 1, ?, ?)`).run(`staff-${suffix}`, `Staff ${suffix}`, `key-${suffix}`, now, now);
    sqlite.prepare(`INSERT INTO tenant_staff_memberships
      (tenant_id, staff_id, role, is_active, created_at, updated_at)
      VALUES (?, ?, 'admin', 1, ?, ?)`).run(`tenant-${suffix}`, `staff-${suffix}`, now, now);
    sqlite.prepare(`INSERT INTO pharmacy_staff_accounts
      (line_account_id, staff_id, is_active, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, now, now);
    sqlite.prepare(`INSERT INTO pharmacy_emergency_settings
      (line_account_id, is_enabled, pharmacy_registration_number, product_code,
       manufacturer_check_url, privacy_policy_url, privacy_contact,
       purpose_text, consent_version, retention_days, consultation_minutes, reservation_ttl_minutes,
       privacy_space_ready, drinking_water_ready, partner_clinic_url, support_center_url,
       updated_by, created_at, updated_at)
      VALUES (?, 1, ?, 'norlevo-otc',
              'https://manufacturer.example/check', 'https://pharmacy.example/privacy',
              'privacy@example.test', '来局前確認と仮受付のため', '2026-01-01', ?, 30, 30, 1, 1,
              'https://clinic.example', 'https://support.example', ?, ?, ?)`).run(
      `account-${suffix}`, `REG-${suffix}`, retentionDays, `staff-${suffix}`, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_emergency_pharmacists
      (line_account_id, staff_id, training_registration_number, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, `TRAIN-${suffix}`, now, now);
    sqlite.prepare(`INSERT INTO pharmacy_emergency_slots
      (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
       capacity, version, created_by, created_at, updated_at)
      VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', '2099-01-01T00:30:00.000Z', 'open', 1, 1, ?, ?, ?)`).run(
      `slot-${suffix}`, `account-${suffix}`, `staff-${suffix}`, `staff-${suffix}`, now, now,
    );
    // Generous stock so INSERTing intakes directly as 'completed' never trips
    // the stock-availability guard (it counts *existing* active holds against
    // this regardless of the row being inserted's own status).
    sqlite.prepare(`INSERT INTO pharmacy_emergency_inventory
      (line_account_id, product_code, on_hand, version, updated_by, created_at, updated_at)
      VALUES (?, 'norlevo-otc', 999999, 1, ?, ?, ?)`).run(`account-${suffix}`, `staff-${suffix}`, now, now);
  }

  let intakeSeq = 0;
  /** Each intake gets its own slot (unique starts_at) so slot/capacity triggers never collide. */
  function insertIntake(
    suffix: 'a' | 'b', createdAt: string, friendId = `friend-${suffix}`,
  ): string {
    intakeSeq += 1;
    const id = `intake-${suffix}-${intakeSeq}`;
    const slotId = `slot-extra-${id}`;
    const startsAt = `2099-01-01T00:${String(intakeSeq).padStart(2, '0')}:00.000Z`;
    const endsAt = `2099-01-01T00:${String(intakeSeq).padStart(2, '0')}:30.000Z`;
    sqlite.prepare(`INSERT INTO pharmacy_emergency_slots
      (id, line_account_id, pharmacist_staff_id, starts_at, ends_at, status,
       capacity, version, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', 1, 1, ?, ?, ?)`).run(
      slotId, `account-${suffix}`, `staff-${suffix}`, startsAt, endsAt, `staff-${suffix}`, createdAt, createdAt,
    );
    sqlite.prepare(`INSERT INTO pharmacy_emergency_intakes
      (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
       status, encrypted_payload, payload_key_version, age_band, safe_contact_mode,
       consent_version, risk_flags_json, product_code, idempotency_key, expires_at,
       version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', 'v1.nonce.ciphertext', 1, 'adult', 'none',
              '2026-01-01', '["flag_a"]', 'norlevo-otc', ?, '2099-01-01T00:00:00.000Z', 1, ?, ?)`).run(
      id, `REF-${id}`, `tenant-${suffix}`, `account-${suffix}`, friendId, slotId,
      `idem-${id}`, createdAt, createdAt,
    );
    return id;
  }

  function insertLegalHold(suffix: 'a' | 'b', friendId: string, releaseAt: string | null): void {
    const now = '2026-01-01T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date, created_at, updated_at)
      VALUES (?, ?, ?, 'self', '氏名', 'シメイ', '1990-01-01', ?, ?)`).run(
      `patient-${friendId}`, `account-${suffix}`, friendId, now, now,
    );
    sqlite.prepare(`INSERT INTO pharmacy_data_subject_requests
      (id, tenant_id, line_account_id, owner_friend_id, patient_id, request_type, status,
       reason, legal_hold, legal_hold_basis, legal_hold_release_at,
       identity_verified_at, legal_hold_assessed_at, submitted_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'erasure', 'legal_hold_assessed', '調査対象のため', 1,
              'pharmacist_law_enforcement_regulation_3y', ?, ?, ?, ?, ?, ?, ?)`).run(
      `dsr-${friendId}`, `tenant-${suffix}`, `account-${suffix}`, friendId, `patient-${friendId}`,
      releaseAt, now, now, now, `staff-${suffix}`, now, now,
    );
  }

  const intakePhi = () => (sqlite.prepare(
    `SELECT id, line_account_id, encrypted_payload, risk_flags_json
       FROM pharmacy_emergency_intakes ORDER BY id`,
  ).all() as Array<Record<string, unknown>>);

  const purgeLog = () => (sqlite.prepare(
    `SELECT * FROM pharmacy_emergency_retention_purge_log ORDER BY resource_id`,
  ).all() as Array<Record<string, unknown>>);

  beforeEach(() => {
    intakeSeq = 0;
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    db = d1From(sqlite);
  });

  test('redacts PHI only for intakes strictly past the account retention_days boundary', async () => {
    seedAccount('a', 30);
    const kept = insertIntake('a', '2026-07-22T12:00:00.001Z'); // 29 days minus 1ms
    const purged = insertIntake('a', '2026-07-21T11:59:59.999Z'); // just past 30 days

    const result = await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 0, skippedFormat: 0, skippedLegalHold: 0 });
    const rows = intakePhi();
    expect(rows.find((r) => r.id === kept)).toMatchObject({
      encrypted_payload: 'v1.nonce.ciphertext', risk_flags_json: '["flag_a"]',
    });
    expect(rows.find((r) => r.id === purged)).toMatchObject({ encrypted_payload: '', risk_flags_json: '[]' });
  });

  test('logs exactly what it redacted, with the account retention_days and no PHI content', async () => {
    seedAccount('a', 30);
    const purged = insertIntake('a', '2023-01-01T00:00:00.000Z');

    await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(purgeLog()).toEqual([{
      id: expect.any(String),
      line_account_id: 'account-a',
      resource_type: 'emergency_intake',
      resource_id: purged,
      age_reference_at: '2023-01-01T00:00:00.000Z',
      retention_days: 30,
      purged_at: NOW.toISOString(),
    }]);
  });

  test('skips and counts intakes with a non-Z-format created_at instead of guessing', async () => {
    seedAccount('a', 30);
    const badId = 'intake-a-bad-format';
    sqlite.prepare(`INSERT INTO pharmacy_emergency_intakes
      (id, reference_code, tenant_id, line_account_id, owner_friend_id, slot_id,
       status, encrypted_payload, payload_key_version, age_band, safe_contact_mode,
       consent_version, risk_flags_json, product_code, idempotency_key, expires_at,
       version, created_at, updated_at)
      VALUES (?, 'REF-bad-format-0001', 'tenant-a', 'account-a', 'friend-a', 'slot-a',
              'completed', 'v1.nonce.ciphertext', 1, 'adult', 'none', '2026-01-01',
              '[]', 'norlevo-otc', 'idem-bad', '2099-01-01T00:00:00.000Z', 1,
              '2019-01-01T00:00:00.000+09:00', '2019-01-01T00:00:00.000+09:00')`).run(badId);

    const result = await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(result).toEqual({ purged: 0, failed: 0, skippedFormat: 1, skippedLegalHold: 0 });
    expect(intakePhi().find((r) => r.id === badId)).toMatchObject({ encrypted_payload: 'v1.nonce.ciphertext' });
  });

  test('skips and counts a due intake whose patient is under an active legal hold', async () => {
    seedAccount('a', 30);
    insertLegalHold('a', 'friend-a', null);
    const held = insertIntake('a', '2023-01-01T00:00:00.000Z');

    const result = await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(result).toEqual({ purged: 0, failed: 0, skippedFormat: 0, skippedLegalHold: 1 });
    expect(intakePhi().find((r) => r.id === held)).toMatchObject({ encrypted_payload: 'v1.nonce.ciphertext' });
    expect(purgeLog()).toEqual([]);
  });

  test('purges once the legal hold release date has passed', async () => {
    seedAccount('a', 30);
    insertLegalHold('a', 'friend-a', '2025-01-01T00:00:00.000Z'); // released before NOW
    const released = insertIntake('a', '2023-01-01T00:00:00.000Z');

    const result = await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 0, skippedFormat: 0, skippedLegalHold: 0 });
    expect(intakePhi().find((r) => r.id === released)).toMatchObject({ encrypted_payload: '' });
  });

  test('is idempotent: a logged redaction is never repeated', async () => {
    seedAccount('a', 30);
    insertIntake('a', '2023-01-01T00:00:00.000Z');

    const first = await purgeEmergencyIntakesPastRetention(db, { now: NOW });
    const second = await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(first.purged).toBe(1);
    expect(second).toEqual({ purged: 0, failed: 0, skippedFormat: 0, skippedLegalHold: 0 });
    expect(purgeLog()).toHaveLength(1);
  });

  test('bounds each account run so a large backlog cannot stall the cron', async () => {
    seedAccount('a', 30);
    for (let i = 0; i < 5; i++) insertIntake('a', '2023-01-01T00:00:00.000Z');

    const result = await purgeEmergencyIntakesPastRetention(db, { now: NOW, limit: 2 });

    expect(result.purged).toBe(2);
    expect(purgeLog()).toHaveLength(2);
  });

  test('applies each account its own retention_days and never mixes accounts', async () => {
    seedAccount('a', 10); // short window: purges even a fairly recent intake
    seedAccount('b', 300); // long window: keeps an equally old intake
    const purgedShort = insertIntake('a', '2026-08-01T00:00:00.000Z'); // 19 days old
    const keptLong = insertIntake('b', '2026-08-01T00:00:00.000Z'); // same age, kept by account b's window

    const result = await purgeEmergencyIntakesPastRetention(db, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 0, skippedFormat: 0, skippedLegalHold: 0 });
    expect(intakePhi().find((r) => r.id === purgedShort)).toMatchObject({ encrypted_payload: '' });
    expect(intakePhi().find((r) => r.id === keptLong)).toMatchObject({ encrypted_payload: 'v1.nonce.ciphertext' });
    expect(purgeLog()).toEqual([expect.objectContaining({ line_account_id: 'account-a', retention_days: 10 })]);
  });

  test('keeps one account failure from stopping the other account purge, without leaking PHI in the result', async () => {
    seedAccount('a', 30);
    seedAccount('b', 30);
    insertIntake('a', '2023-01-01T00:00:00.000Z');
    const purgedB = insertIntake('b', '2023-01-01T00:00:00.000Z');

    const faultyDb: D1Database = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.includes('UPDATE pharmacy_emergency_intakes') || !sql.includes('encrypted_payload')) {
          return statement;
        }
        return {
          ...statement,
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values) as unknown as RunnableStatement;
            if (values.includes('account-a')) {
              return {
                ...bound,
                run: () => { throw new Error('database is locked'); },
                runSync: () => { throw new Error('database is locked'); },
              };
            }
            return bound;
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;

    const result = await purgeEmergencyIntakesPastRetention(faultyDb, { now: NOW });

    expect(result).toEqual({ purged: 1, failed: 1, skippedFormat: 0, skippedLegalHold: 0 });
    expect(intakePhi().find((r) => r.id === purgedB)).toMatchObject({ encrypted_payload: '' });
    expect(JSON.stringify(result)).not.toMatch(/patient|friend|ciphertext|risk_flag/iu);
  });
});
