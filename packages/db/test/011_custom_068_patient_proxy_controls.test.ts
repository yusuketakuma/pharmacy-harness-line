import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '011_custom_068_patient_proxy_controls.sql';

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

describe('011 custom_068 patient proxy controls', () => {
  it('adds tenant-scoped proxy grants, owner controls, and intake provenance', () => {
    const db = loadPreMigrationDb();
    db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION), 'utf8'));
    db.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES
        ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', '2026-09-01', '2026-09-01'),
        ('account-b', 'channel-b', 'B', 'token-b', 'secret-b', '2026-09-01', '2026-09-01');
      INSERT INTO friends (id, line_user_id, line_account_id, created_at, updated_at)
      VALUES
        ('friend-a', 'U-a', 'account-a', '2026-09-01', '2026-09-01'),
        ('friend-b', 'U-b', 'account-b', '2026-09-01', '2026-09-01');
      INSERT INTO pharmacy_patients
        (id, line_account_id, owner_friend_id, relationship, name, name_kana,
         birth_date, created_at, updated_at)
      VALUES ('patient-a', 'account-a', 'friend-a', 'child', 'A', 'エー',
              '2018-01-01', '2026-09-01', '2026-09-01');
    `);

    expect(() => db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('grant-a', 'account-a', 'patient-a', 'friend-a', 'patient_intake_v1',
              'self_attested', 1, ?, '2026-09-01T00:00:00.000Z',
              '2026-12-01T00:00:00.000Z', 1, '2026-09-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z')`).run('a'.repeat(64))).not.toThrow();

    expect(() => db.prepare(`INSERT INTO pharmacy_patient_proxy_grants
      (id, line_account_id, patient_id, actor_friend_id, permission_code, basis_code,
       terms_version, terms_hash, granted_at, expires_at, version, created_at, updated_at)
      VALUES ('cross-owner', 'account-a', 'patient-a', 'friend-b', 'patient_intake_v1',
              'self_attested', 1, ?, '2026-09-01T00:00:00.000Z',
              '2026-12-01T00:00:00.000Z', 1, '2026-09-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z')`).run('b'.repeat(64))).toThrow(/FOREIGN KEY/);

    expect(() => db.prepare(`INSERT INTO pharmacy_patient_owner_controls
      (line_account_id, patient_id, owner_friend_id, version, updated_at)
      VALUES ('account-a', 'patient-a', 'friend-b', 1, '2026-09-01T00:00:00.000Z')`).run())
      .toThrow(/FOREIGN KEY/);

    expect(db.prepare(`PRAGMA table_info(pharmacy_patient_intake_responses)`).all()
      .some((row) => (row as { name: string }).name === 'proxy_grant_id')).toBe(true);

    expect(() => db.prepare(`INSERT INTO pharmacy_patient_intake_responses
      (id, line_account_id, owner_friend_id, patient_id, revision, schema_version,
       patient_snapshot_json, answers_json, idempotency_key,
       representative_consent_at, privacy_consent_at, created_at)
      VALUES ('legacy-response', 'account-a', 'friend-a', 'patient-a', 1, 2,
              '{}', '{}', 'legacy-key', '2026-09-01T00:00:00.000Z',
              '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`).run())
      .not.toThrow();
    expect(db.prepare(`SELECT proxy_grant_id FROM pharmacy_patient_intake_responses
      WHERE id = 'legacy-response'`).get()).toEqual({ proxy_grant_id: null });
  });
});
