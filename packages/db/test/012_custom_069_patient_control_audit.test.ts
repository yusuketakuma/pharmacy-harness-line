import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '012_custom_069_patient_control_audit.sql';

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

describe('012 custom_069 patient control audit', () => {
  it('stores immutable PHI-free control transitions in patient scope', () => {
    const db = loadPreMigrationDb();
    db.exec(readFileSync(join(ROOT, 'migrations', MIGRATION), 'utf8'));
    db.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
      VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', '2026-09-01', '2026-09-01');
      INSERT INTO friends (id, line_user_id, line_account_id, created_at, updated_at)
      VALUES ('friend-a', 'U-a', 'account-a', '2026-09-01', '2026-09-01');
      INSERT INTO pharmacy_patients
        (id, line_account_id, owner_friend_id, relationship, name, name_kana,
         birth_date, created_at, updated_at)
      VALUES ('patient-a', 'account-a', 'friend-a', 'self', 'A', 'エー',
              '2000-01-01', '2026-09-01', '2026-09-01');
      INSERT INTO pharmacy_patient_control_audit_events
        (id, line_account_id, patient_id, owner_friend_id, actor_kind, actor_id, action,
         control_version, created_at)
      VALUES ('audit-a', 'account-a', 'patient-a', 'friend-a', 'patient', 'friend-a',
              'privacy_withdrawn', 1, '2026-09-01T00:00:00.000Z');
    `);

    expect(() => db.prepare(`UPDATE pharmacy_patient_control_audit_events
      SET action = 'privacy_reconsented' WHERE id = 'audit-a'`).run()).toThrow(/immutable/);
    expect(() => db.prepare(`DELETE FROM pharmacy_patient_control_audit_events
      WHERE id = 'audit-a'`).run()).toThrow(/immutable/);
    expect(() => db.prepare(`INSERT INTO pharmacy_patient_control_audit_events
      (id, line_account_id, patient_id, owner_friend_id, actor_kind, actor_id, action,
       control_version, created_at)
      VALUES ('bad-action', 'account-a', 'patient-a', 'friend-a', 'patient', 'friend-a',
              'answers_changed', 2, '2026-09-01T00:00:00.000Z')`).run()).toThrow(/CHECK/);
  });
});
