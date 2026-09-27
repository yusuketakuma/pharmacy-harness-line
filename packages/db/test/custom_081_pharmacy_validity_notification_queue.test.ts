import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { splitSqlStatements } from '../scripts/split-sql-statements.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = '029_custom_081_pharmacy_validity_notification_queue.sql';

it('adds scheduling metadata while preserving existing rows and previous-version writes', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  try {
    for (const file of readdirSync(join(root, 'migrations'))
      .filter((name) => name.endsWith('.sql') && name < migration)
      .sort()) {
      for (const statement of splitSqlStatements(readFileSync(join(root, 'migrations', file), 'utf8'))) {
        // Match the bootstrap generator for historical idempotent additions.
        try {
          sqlite.exec(statement);
        } catch (error) {
          if (!(error instanceof Error) || !/duplicate column name|already exists/i.test(error.message)) throw error;
        }
      }
    }
    const now = '2026-09-22T00:00:00.000Z';
    for (const x of ['a', 'b']) {
      sqlite.exec(`INSERT INTO tenants(id,tenant_code,display_name,outbound_messaging_paused_at) VALUES ('tenant-${x}','tenant-${x}','Synthetic',${x === 'a' ? "'2026-09-21T00:00:00.000Z'" : 'NULL'});
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('account-${x}','channel-${x}','Synthetic','synthetic','synthetic');
 INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES ('tenant-${x}','account-${x}');
 UPDATE pharmacy_account_capabilities SET capabilities_json='["prescription_intake"]' WHERE line_account_id='account-${x}';
 INSERT INTO friends(id,line_user_id,provider_line_user_id,line_account_id,is_following) VALUES ('friend-${x}','user-${x}','provider-${x}','account-${x}',1);
 INSERT INTO pharmacy_patients(id,line_account_id,owner_friend_id,relationship,name,name_kana,birth_date,created_at,updated_at) VALUES ('patient-${x}','account-${x}','friend-${x}','self','Synthetic','Synthetic','1990-01-01','${now}','${now}');
 INSERT INTO pharmacy_patient_intake_responses(id,line_account_id,owner_friend_id,patient_id,revision,schema_version,patient_snapshot_json,answers_json,idempotency_key,representative_consent_at,privacy_consent_at,created_at) VALUES ('response-${x}','account-${x}','friend-${x}','patient-${x}',1,1,'{}','{}','synthetic-key','${now}','${now}','${now}');`);
    }
    for (let i = 0; i < 1; i++) {
      const x = i < 50 ? 'a' : 'b';
      const id = String(i).padStart(3, '0');
      sqlite.exec(`INSERT INTO pharmacy_prescription_submissions(id,line_account_id,friend_id,idempotency_key,status,created_at,updated_at) VALUES ('sub-${id}','account-${x}','friend-${x}','synthetic-${id}','ready','${now}','${now}');
 INSERT INTO pharmacy_prescription_patients(submission_id,line_account_id,owner_friend_id,patient_id,intake_response_id,created_at) VALUES ('sub-${id}','account-${x}','friend-${x}','patient-${x}','response-${x}','${now}');
 INSERT INTO pharmacy_prescription_validities(submission_id,line_account_id,issued_on,valid_until,validity_basis,verification_status,verified_by,verified_at,reminder_due_at,created_at,updated_at) VALUES ('sub-${id}','account-${x}','2026-09-21','2026-09-24','default_4_days','verified','synthetic-staff','${now}','2026-09-21T00:00:00.000Z','${now}','${now}');`);
    }

    const previous = sqlite.prepare('SELECT * FROM pharmacy_prescription_validities').all();
    const oldColumns = sqlite
      .prepare('PRAGMA table_info(pharmacy_prescription_validities)')
      .all()
      .map((row: any) => row.name);
    expect(oldColumns).not.toContain('notification_checked_at');
    sqlite.exec(readFileSync(join(root, 'migrations', migration), 'utf8'));
    const current = sqlite.prepare('SELECT * FROM pharmacy_prescription_validities').all() as Record<string, unknown>[];
    expect(current.map(({ notification_checked_at, ...row }) => row)).toEqual(previous);
    expect(current.every((row) => row.notification_checked_at === null)).toBe(true);
    sqlite
      .prepare(
        "UPDATE pharmacy_prescription_validities SET verification_status='expired_confirmed' WHERE submission_id=? AND line_account_id=?",
      )
      .run('sub-000', 'account-a');
    expect(
      sqlite
        .prepare(
          "SELECT verification_status,notification_checked_at FROM pharmacy_prescription_validities WHERE submission_id='sub-000'",
        )
        .get(),
    ).toEqual({ verification_status: 'expired_confirmed', notification_checked_at: null });
    expect(() => sqlite.exec("UPDATE pharmacy_prescription_validities SET notification_checked_at='invalid'")).toThrow(
      /CHECK constraint/,
    );
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE name='idx_pharmacy_validity_notification_queue'").get(),
    ).toEqual({ name: 'idx_pharmacy_validity_notification_queue' });
  } finally {
    sqlite.close();
  }
});
