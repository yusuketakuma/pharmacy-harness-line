import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { d1FromSqlite, DB_PACKAGE_ROOT, openTestSqlite } from '../test-sqlite.js';

const send = vi.hoisted(() => vi.fn());
const readCredential = vi.hoisted(() => vi.fn());
vi.mock('../growth-loop/sender.js', () => ({ sendPharmacyAutomatedPush: send }));
vi.mock('../provisioning/line-credential-store.js', () => ({ readLineCredential: readCredential }));
vi.mock('../beta-membership/repository.js', async (original) => ({
  ...(await original<typeof import('../beta-membership/repository.js')>()),
  getPharmacyBetaNotificationBinding: vi.fn().mockResolvedValue(null),
}));
import { claimDueNextIntakeExpectations } from './next-intake.js';
import { deliverContinuityReminder } from './notifications.js';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const migration = '028_custom_080_pharmacy_continuity_notification_queue.sql';
const { splitSqlStatements } = createRequire(import.meta.url)(
  join(DB_PACKAGE_ROOT, 'scripts/split-sql-statements.mjs'),
) as { splitSqlStatements: (sql: string) => string[] };

function setup(legacy = false) {
  const sqlite = openTestSqlite({ foreignKeys: true });
  try {
    if (legacy) {
      for (const file of readdirSync(join(DB_PACKAGE_ROOT, 'migrations'))
        .filter((name) => name.endsWith('.sql') && name < migration)
        .sort()) {
        for (const statement of splitSqlStatements(readFileSync(join(DB_PACKAGE_ROOT, 'migrations', file), 'utf8'))) {
          try {
            sqlite.exec(statement);
          } catch (error) {
            // The bootstrap generator permits these historical idempotent additions.
            if (!(error instanceof Error) || !/duplicate column name|already exists/i.test(error.message)) throw error;
          }
        }
      }
    } else {
      sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
    }
    const now = '2026-09-22T00:00:00.000Z';
    for (const x of ['a', 'b']) {
      sqlite.exec(`INSERT INTO tenants(id,tenant_code,display_name,outbound_messaging_paused_at) VALUES ('tenant-${x}','tenant-${x}','Synthetic',${x === 'a' ? "'2026-09-21T00:00:00.000Z'" : 'NULL'});
 INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('account-${x}','channel-${x}','Synthetic','synthetic','synthetic');
 INSERT INTO tenant_line_accounts(tenant_id,line_account_id) VALUES ('tenant-${x}','account-${x}');
 UPDATE pharmacy_account_capabilities SET capabilities_json='["continuity"]' WHERE line_account_id='account-${x}';
 INSERT INTO friends(id,line_user_id,provider_line_user_id,line_account_id,is_following) VALUES ('friend-${x}','user-${x}','provider-${x}','account-${x}',1);
 INSERT INTO pharmacy_patients(id,line_account_id,owner_friend_id,relationship,name,name_kana,birth_date,created_at,updated_at) VALUES ('patient-${x}','account-${x}','friend-${x}','self','Synthetic','Synthetic','1990-01-01','${now}','${now}');
 INSERT INTO pharmacy_patient_intake_responses(id,line_account_id,owner_friend_id,patient_id,revision,schema_version,patient_snapshot_json,answers_json,idempotency_key,representative_consent_at,privacy_consent_at,created_at) VALUES ('response-${x}','account-${x}','friend-${x}','patient-${x}',1,1,'{}','{}','synthetic-key','${now}','${now}','${now}');`);
    }
    for (let i = 0; i < 51; i++) {
      const x = i < 50 ? 'a' : 'b';
      const id = String(i).padStart(3, '0');
      sqlite.exec(`INSERT INTO pharmacy_patients(id,line_account_id,owner_friend_id,relationship,name,name_kana,birth_date,created_at,updated_at) VALUES ('patient-${id}','account-${x}','friend-${x}','other','Synthetic','Synthetic','1990-01-01','${now}','${now}');
 INSERT INTO pharmacy_patient_intake_responses(id,line_account_id,owner_friend_id,patient_id,revision,schema_version,patient_snapshot_json,answers_json,idempotency_key,representative_consent_at,privacy_consent_at,created_at) VALUES ('response-${id}','account-${x}','friend-${x}','patient-${id}',1,1,'{}','{}','synthetic-key-${id}','${now}','${now}','${now}');
 INSERT INTO pharmacy_prescription_submissions(id,line_account_id,friend_id,idempotency_key,status,created_at,updated_at) VALUES ('sub-${id}','account-${x}','friend-${x}','synthetic-${id}','closed','${now}','${now}');
 INSERT INTO pharmacy_prescription_patients(submission_id,line_account_id,owner_friend_id,patient_id,intake_response_id,created_at) VALUES ('sub-${id}','account-${x}','friend-${x}','patient-${id}','response-${id}','${now}');
 INSERT INTO pharmacy_continuity_obligations(id,line_account_id,owner_friend_id,patient_id,source_submission_id,status,expected_next_from,expected_next_to,next_contact_at,consent_at,created_at,updated_at) VALUES ('obligation-${id}','account-${x}','friend-${x}','patient-${id}','sub-${id}','active','2026-09-21','2026-10-21','2026-09-21T00:00:00.000Z','${now}','${now}','${now}');
 INSERT INTO pharmacy_next_intake_expectations(id,obligation_id,line_account_id,owner_friend_id,patient_id,status,timing_source,expected_from,expected_to,reminder_at,created_by,created_at,updated_at) VALUES ('expectation-${id}','obligation-${id}','account-${x}','friend-${x}','patient-${id}','active','manual_window','2026-09-21','2026-10-21','2026-09-21T00:00:00.000Z','synthetic-staff','${now}','${now}');`);
    }

    return { sqlite, db: d1FromSqlite(sqlite) };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

beforeEach(() => {
  send.mockReset().mockResolvedValue('paused');
  readCredential.mockReset().mockResolvedValue('synthetic-token');
});

async function tick(db: D1Database, now = NOW) {
  const rows = await claimDueNextIntakeExpectations(db, now);
  const outcomes = [];
  for (const row of rows)
    outcomes.push(
      await deliverContinuityReminder(row, {
        db,
        proxyBaseUrl: 'https://synthetic.invalid',
        lineCredentialKey: 'synthetic',
      }),
    );
  return { rows, outcomes };
}

it.each(['paused', 'failure', 'credential_missing'])(
  'advances past fifty %s rows without changing clinical state',
  async (mode) => {
    if (mode === 'failure') send.mockRejectedValue(new Error('synthetic failure'));
    if (mode === 'credential_missing') readCredential.mockResolvedValue(null);
    const { sqlite, db } = setup();
    try {
      const first = await tick(db);
      const second = await tick(db, new Date(NOW.getTime() + 21600000));
      expect(first.rows).toHaveLength(50);
      expect(first.rows.map((row) => row.id)).not.toContain('expectation-050');
      expect(second.rows).toHaveLength(50);
      expect(second.rows.map((row) => row.id)).toContain('expectation-050');
      if (mode === 'credential_missing') expect(send).not.toHaveBeenCalled();
      else expect(send.mock.calls.some(([input]) => input.lineAccountId === 'account-b')).toBe(true);
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM pharmacy_next_intake_expectations WHERE status='active' AND version=1 AND reminder_at='2026-09-21T00:00:00.000Z'",
          )
          .get(),
      ).toEqual({ count: 51 });
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  },
);

it('preserves old-schema rows, ordering and delivery behavior', async () => {
  const { sqlite, db } = setup(true);
  try {
    const first = await tick(db);
    const second = await tick(db, new Date(NOW.getTime() + 21600000));
    expect(first.rows).toHaveLength(50);
    expect(second.rows).toEqual(first.rows);
    expect(second.outcomes).toEqual(Array(50).fill('skipped'));
    expect(first.rows[0]).not.toHaveProperty('notification_checked_at');
  } finally {
    sqlite.close();
  }
});

it('revisits paused rows and records confirmed delivery after resumption', async () => {
  const { sqlite, db } = setup();
  try {
    await tick(db);
    await tick(db, new Date(NOW.getTime() + 21600000));
    sqlite.exec("UPDATE tenants SET outbound_messaging_paused_at=NULL WHERE id='tenant-a'");
    send.mockResolvedValue('sent');
    const result = await tick(db, new Date(NOW.getTime() + 43200000));
    expect(result.outcomes).toEqual(Array(50).fill('sent'));
    expect(
      sqlite.prepare("SELECT status,version FROM pharmacy_next_intake_expectations WHERE id='expectation-000'").get(),
    ).toEqual({ status: 'reminded', version: 2 });
  } finally {
    sqlite.close();
  }
});

it('preserves accepted activation and its audit event', async () => {
  const { sqlite, db } = setup();
  try {
    sqlite.exec("UPDATE pharmacy_next_intake_expectations SET status='accepted' WHERE id='expectation-000'");
    const rows = await claimDueNextIntakeExpectations(db, NOW, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'expectation-000', status: 'active', version: 2 });
    expect(rows[0]).not.toHaveProperty('notification_checked_at');
    expect(
      sqlite
        .prepare(
          "SELECT event_type,from_status,to_status FROM pharmacy_next_intake_expectation_events WHERE expectation_id='expectation-000'",
        )
        .all(),
    ).toEqual([{ event_type: 'active', from_status: 'accepted', to_status: 'active' }]);
  } finally {
    sqlite.close();
  }
});

it.each(['tenant', 'account', 'version', 'ended', 'write_failure'])(
  'does not dispatch a selected row after a %s conflict',
  async (conflict) => {
    const { sqlite, db } = setup();
    const intercepted = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.includes('UPDATE pharmacy_next_intake_expectations')) return statement;
        return {
          bind: (...values: unknown[]) => {
            if (conflict === 'tenant') sqlite.exec("UPDATE tenants SET status='suspended' WHERE id='tenant-a'");
            if (conflict === 'account') sqlite.exec("UPDATE line_accounts SET is_active=0 WHERE id='account-a'");
            if (conflict === 'version')
              sqlite.exec("UPDATE pharmacy_next_intake_expectations SET version=version+1 WHERE id='expectation-000'");
            if (conflict === 'ended')
              sqlite.exec("UPDATE pharmacy_next_intake_expectations SET status='ended' WHERE id='expectation-000'");
            if (conflict === 'write_failure') throw new Error('synthetic write failure');
            return statement.bind(...values);
          },
        };
      },
    } as D1Database;
    try {
      expect(await claimDueNextIntakeExpectations(intercepted, NOW, 1)).toEqual([]);
      expect(
        sqlite
          .prepare("SELECT notification_checked_at FROM pharmacy_next_intake_expectations WHERE id='expectation-000'")
          .get(),
      ).toEqual({ notification_checked_at: null });
    } finally {
      sqlite.close();
    }
  },
);

it('does not move the queue timestamp backwards on an older cron tick', async () => {
  const { sqlite, db } = setup();
  try {
    const later = new Date(NOW.getTime() + 21600000);
    await claimDueNextIntakeExpectations(db, later, 100);
    await claimDueNextIntakeExpectations(db, NOW, 100);
    expect(
      sqlite.prepare('SELECT DISTINCT notification_checked_at FROM pharmacy_next_intake_expectations').all(),
    ).toEqual([{ notification_checked_at: later.toISOString() }]);
  } finally {
    sqlite.close();
  }
});
