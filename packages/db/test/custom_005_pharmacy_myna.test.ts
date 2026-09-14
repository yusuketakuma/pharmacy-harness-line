import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getActivePatientMynaHandoff,
  recordMynaPatientReport,
} from '../../../apps/worker/src/custom/pharmacy/myna/repository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
  return db;
}

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    runSync: () => ({
      success: true,
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
      results: [],
    }) as unknown as D1Result,
    run: async () => statement(sql, values).runSync(),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => sqlite.transaction(() =>
      statements.map((item) => (item as ReturnType<typeof statement>).runSync()),
    )() as unknown as D1Result<T>[],
  } as unknown as D1Database;
}

describe('custom_005_pharmacy_myna.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
  });

  it('adds Myna handoff, verification, endpoint and expectation tables', () => {
    for (const table of [
      'pharmacy_myna_endpoint_configs',
      'pharmacy_myna_handoffs',
      'pharmacy_myna_verifications',
      'pharmacy_myna_events',
      'pharmacy_prescription_expectations',
    ]) {
      expect(db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table)).toEqual({ name: table });
    }
  });

  it('extends the existing FulfillmentQuote table without replacing its decision contract', () => {
    const columns = db.prepare('PRAGMA table_info(pharmacy_fulfillment_quotes)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining([
      'decision', 'reason_codes_json', 'requirements_json', 'status',
      'fulfillment_method', 'constraints_json', 'reservation_expires_at',
      'confirmed_by', 'confirmed_at',
    ]));
  });

  it('does not create Myna or prescription-content storage fields', () => {
    const sensitiveNames = db.prepare('PRAGMA table_info(pharmacy_myna_handoffs)').all() as Array<{ name: string }>;
    expect(sensitiveNames.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'myna_number', 'card_number', 'pin', 'prescription_json', 'screenshot_url',
    ]));
  });

  it('hides a linked child handoff and rejects patient report after proxy revoke', async () => {
    const now = '2026-08-18T00:00:00.000Z';
    const d1 = d1From(db);
    db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', '薬局', 'token', 'secret', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO tenants
      (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES ('tenant-a', 'pharmacy-a', 'Tenant A', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO tenant_line_accounts
      (tenant_id, line_account_id, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO friends
      (id, line_user_id, line_account_id, provider_line_user_id, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', 'U-a', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana,
       birth_date, created_at, updated_at)
      VALUES ('patient-child', 'account-a', 'friend-a', 'child', 'Child', 'CHILD',
              '2018-01-01', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('grant-child', 'account-a', 'patient-child', 'friend-a', 'patient_intake_v1',
              'self_attested_guardian', 1, ?, ?, '2099-01-01T00:00:00.000Z', 1, ?, ?)`).run(
      'a'.repeat(64), now, now, now,
    );
    db.prepare(`UPDATE pharmacy_account_capabilities
      SET capabilities_json = '["electronic_prescription"]', updated_at = ?
      WHERE line_account_id = 'account-a'`).run(now);

    db.prepare(`INSERT INTO pharmacy_myna_handoffs
      (id, line_account_id, friend_id, patient_id, expectation_id, method, status,
       source, correlation_id, expires_at, created_at, updated_at)
      VALUES ('handoff-child', 'account-a', 'friend-a', 'patient-child', NULL,
              'E_PRESCRIPTION', 'CREATED', 'LIFF', 'proxy-myna-1',
              '2099-01-01T00:00:00.000Z', ?, ?)`).run(now, now);
    await expect(getActivePatientMynaHandoff(d1, 'account-a', 'friend-a'))
      .resolves.toMatchObject({ id: 'handoff-child', patient_id: 'patient-child' });

    db.prepare(`UPDATE pharmacy_patient_proxy_grants
      SET revoked_at = ?, revoke_reason_code = 'user_revoked', version = version + 1,
          updated_at = ? WHERE id = 'grant-child'`).run(now, now);

    await expect(getActivePatientMynaHandoff(d1, 'account-a', 'friend-a')).resolves.toBeNull();
    await expect(recordMynaPatientReport(
      d1, 'account-a', 'friend-a', 'handoff-child', 'COMPLETED',
    )).rejects.toThrow(/Myna handoff not found/i);
    expect(db.prepare(`SELECT status FROM pharmacy_myna_handoffs WHERE id = ?`)
      .get('handoff-child')).toEqual({ status: 'CREATED' });
  });
});
