import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '013_custom_070_patient_proxy_lifecycle.sql';

function loadPreMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((name) =>
    name.endsWith('.sql') && name < MIGRATION).sort()) {
    for (const statement of readFileSync(join(ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((sql) => sql.trim()).filter(Boolean)) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!/duplicate column name|already exists/i.test(String(error))) throw error;
      }
    }
  }
  return db;
}

describe('013 custom_070 patient proxy lifecycle', () => {
  it('enforces one immutable current grant and idempotent registration keys', () => {
    const db = loadPreMigrationDb();
    db.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', '2026-09-01', '2026-09-01');
      INSERT INTO friends (id, line_user_id, line_account_id, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', '2026-09-01', '2026-09-01');
      INSERT INTO pharmacy_patients
        (id, line_account_id, owner_friend_id, relationship, name, name_kana,
         birth_date, created_at, updated_at)
      VALUES ('patient-a', 'account-a', 'friend-a', 'child', 'A', 'エー',
              '2018-01-01', '2026-09-01', '2026-09-01');
      INSERT INTO pharmacy_patient_proxy_grants
        (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
         terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('grant-a', 'account-a', 'patient-a', 'friend-a', 'patient_intake_v1',
              'self_attested_guardian', 1, '${'a'.repeat(64)}',
              '2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 1,
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);

    db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION), 'utf8'));

    expect(db.prepare(`PRAGMA table_info(pharmacy_patient_proxy_grants)`).all()
      .some((row) => (row as { name: string }).name === 'last_transition_id')).toBe(true);

    expect(() => db.exec(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana,
       birth_date, created_at, updated_at)
      VALUES ('legacy-patient', 'account-a', 'friend-a', 'self', 'Legacy', 'レガシー',
              '2000-01-01', '2026-09-02', '2026-09-02')`)).not.toThrow();

    expect(() => db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('grant-b', 'account-a', 'patient-a', 'friend-a', 'patient_intake_v1',
              'self_attested_guardian', 1, ?, '2026-09-02T00:00:00.000Z',
              '2026-12-02T00:00:00.000Z', 1, '2026-09-02T00:00:00.000Z',
              '2026-09-02T00:00:00.000Z')`).run('b'.repeat(64))).toThrow(/UNIQUE/);
    expect(() => db.prepare(`UPDATE pharmacy_patient_proxy_grants
      SET terms_hash = ? WHERE id = 'grant-a'`).run('c'.repeat(64))).toThrow(/immutable/);

    db.exec(`UPDATE pharmacy_patients SET registration_idempotency_key = 'register-1',
      registration_request_hash = '${'d'.repeat(64)}' WHERE id = 'patient-a'`);
    expect(() => db.prepare(`INSERT INTO pharmacy_patients
      (id, line_account_id, owner_friend_id, relationship, name, name_kana, birth_date,
       registration_idempotency_key, registration_request_hash, created_at, updated_at)
      VALUES ('patient-b', 'account-a', 'friend-a', 'child', 'B', 'ビー', '2019-01-01',
              'register-1', ?, '2026-09-02', '2026-09-02')`).run('e'.repeat(64)))
      .toThrow(/UNIQUE/);
  });
});
