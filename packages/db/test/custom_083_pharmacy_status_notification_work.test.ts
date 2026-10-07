import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../scripts/split-sql-statements.mjs';

const root = new URL('..', import.meta.url).pathname;
const migration = readFileSync(join(root, 'migrations/031_custom_083_pharmacy_status_notification_work.sql'), 'utf8');
function previousSchema() {
  const db = new Database(':memory:');
  for (const file of readdirSync(join(root, 'migrations'))
    .filter((file) => file.endsWith('.sql') && file < '031_')
    .sort()) {
    for (const statement of splitSqlStatements(readFileSync(join(root, 'migrations', file), 'utf8'))) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name|already exists/i.test(error.message)) throw error;
      }
    }
  }
  return db;
}

describe('custom_083 status work migration', () => {
  it('repairs a missed EXPIRED timestamp refresh during partial installation without resetting a lease or done work', () => {
    const db = previousSchema();
    try {
      db.exec(splitSqlStatements(migration).slice(0, 4).join(';'));
      db.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret)
        VALUES('a','a','synthetic','synthetic','synthetic');
        INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f','f','a');`);
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 73 * 3600_000).toISOString();
      const lease = new Date(Date.now() + 300_000).toISOString();
      for (const id of ['expired', 'leased', 'done', 'unchanged']) {
        db.prepare(`INSERT INTO pharmacy_myna_handoffs
          (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
          VALUES(?,'a','f','PAPER','EXPIRED','LIFF',?,?,?,?)`).run(id, id, old, old, old);
      }
      db.exec(
        "UPDATE pharmacy_status_notification_work SET state='expired' WHERE source_id IN ('expired','unchanged')",
      );
      db.exec("UPDATE pharmacy_status_notification_work SET state='done' WHERE source_id='done'");
      db.prepare(
        "UPDATE pharmacy_status_notification_work SET due_at=?,claim_token='owner',attempt_count=3 WHERE source_id='leased'",
      ).run(lease);
      db.prepare("UPDATE pharmacy_myna_handoffs SET status='EXPIRED',updated_at=? WHERE id!='unchanged'").run(now);
      db.exec(migration);
      db.exec(migration);
      const expires = new Date(Date.parse(now) + 72 * 3600_000).toISOString();
      expect(
        db.prepare("SELECT state,expires_at FROM pharmacy_status_notification_work WHERE source_id='expired'").get(),
      ).toEqual({ state: 'pending', expires_at: expires });
      expect(
        db
          .prepare(
            "SELECT state,expires_at,due_at,claim_token,attempt_count FROM pharmacy_status_notification_work WHERE source_id='leased'",
          )
          .get(),
      ).toEqual({ state: 'pending', expires_at: expires, due_at: lease, claim_token: 'owner', attempt_count: 3 });
      expect(db.prepare("SELECT state FROM pharmacy_status_notification_work WHERE source_id='done'").get()).toEqual({
        state: 'done',
      });
      expect(
        db.prepare("SELECT state FROM pharmacy_status_notification_work WHERE source_id='unchanged'").get(),
      ).toEqual({ state: 'expired' });
    } finally {
      db.close();
    }
  });
  it('backfills recent unsent work, preserves failed retries and separates accounts, and resync is idempotent', () => {
    const db = previousSchema();
    try {
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 73 * 3600_000).toISOString();
      for (const account of ['a', 'b']) {
        db.prepare(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret)
          VALUES (?, ?, ?, 'synthetic','synthetic')`).run(account, account, account);
        db.prepare(`INSERT INTO friends(id,line_user_id,line_account_id) VALUES (?, ?, ?)`).run(
          `friend-${account}`,
          account,
          account,
        );
      }
      const insert = db.prepare(`INSERT INTO pharmacy_myna_handoffs
        (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
        VALUES (?, 'a', 'friend-a','PAPER','EXPIRED','LIFF',?,?,?,?)`);
      for (const id of ['sent', 'failed', 'other-account', 'old']) {
        const ts = id === 'old' ? old : now;
        insert.run(id, id, ts, ts, ts);
      }
      const notice = db.prepare(`INSERT INTO pharmacy_notification_events
        (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
        VALUES (?, ?, ?, 'myna_handoff_status_v1','transactional_care',?,?,?,?)`);
      notice.run('sent', 'a', 'friend-a', 'sent', now, 'myna-status:sent:EXPIRED', now);
      notice.run('failed', 'a', 'friend-a', 'failed', now, 'myna-status:failed:EXPIRED', now);
      notice.run('other', 'b', 'friend-b', 'sent', now, 'myna-status:other-account:EXPIRED', now);
      // Only this migration fixture uses a synthetic source id; Worker tests
      // exercise the queue with foreign keys enabled.
      db.pragma('foreign_keys = OFF');
      // Emergency immutable events can be created by an older Worker before migration.
      db.prepare(`INSERT INTO pharmacy_emergency_intake_events
        (id,intake_id,line_account_id,event_type,actor_type,actor_id,idempotency_key,occurred_at)
        VALUES ('event','synthetic-intake','a','reviewed','system','system','event-key',?)`).run(now);
      db.exec(migration);
      expect(
        db.prepare(`SELECT kind,source_id FROM pharmacy_status_notification_work ORDER BY kind,source_id`).all(),
      ).toEqual([
        { kind: 'emergency', source_id: 'event' },
        { kind: 'myna', source_id: 'failed' },
        { kind: 'myna', source_id: 'other-account' },
      ]);
      db.exec(
        `UPDATE pharmacy_status_notification_work SET attempt_count=3,claim_token='current' WHERE source_id='failed'`,
      );
      const backfill = splitSqlStatements(migration).filter((sql: string) =>
        /^\s*(?:--[^\n]*\n\s*)*INSERT OR IGNORE/i.test(sql),
      );
      expect(backfill).toHaveLength(2);
      db.exec(backfill.join(';'));
      expect(
        db
          .prepare(`SELECT attempt_count,claim_token FROM pharmacy_status_notification_work WHERE source_id='failed'`)
          .get(),
      ).toEqual({ attempt_count: 3, claim_token: 'current' });
    } finally {
      db.close();
    }
  });
  it.each(Array.from({ length: splitSqlStatements(migration).length + 1 }, (_, index) => index))(
    'resumes partial 031 prefix %i and replays 030/031 without duplicate work',
    (prefix) => {
      const statements = splitSqlStatements(migration);
      const indexMigration = readFileSync(
        join(root, 'migrations/030_custom_082_pharmacy_cron_scan_indexes.sql'),
        'utf8',
      );
      const db = previousSchema();
      try {
        const now = new Date().toISOString();
        db.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret)
          VALUES('a','a','synthetic','synthetic','synthetic');
          INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f','f','a');`);
        db.exec(statements.slice(0, prefix).join(';'));
        for (const id of ['unsent', 'sent']) {
          db.prepare(`INSERT INTO pharmacy_myna_handoffs
            (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
            VALUES(?,'a','f','PAPER','EXPIRED','LIFF',?,?,?,?)`).run(id, id, now, now, now);
        }
        db.prepare(`INSERT INTO pharmacy_notification_events
          (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
          VALUES('notice','a','f','myna_handoff_status_v1','transactional_care','sent',?,'myna-status:sent:EXPIRED',?)`).run(
          now,
          now,
        );
        db.exec(indexMigration);
        db.exec(migration);
        db.exec(indexMigration);
        db.exec(migration);
        expect(
          db.prepare(`SELECT source_id FROM pharmacy_status_notification_work WHERE state='pending'`).all(),
        ).toEqual([{ source_id: 'unsent' }]);
        expect(
          db
            .prepare(`SELECT COUNT(*) AS n FROM pharmacy_status_notification_work
          WHERE retry_key='myna-status:unsent:EXPIRED'`)
            .get(),
        ).toEqual({ n: 1 });
        db.exec(
          `UPDATE pharmacy_status_notification_work SET claim_token='owner',attempt_count=4 WHERE source_id='unsent'`,
        );
        db.exec(migration);
        expect(
          db
            .prepare(`SELECT claim_token,attempt_count FROM pharmacy_status_notification_work WHERE source_id='unsent'`)
            .get(),
        ).toEqual({ claim_token: 'owner', attempt_count: 4 });
      } finally {
        db.close();
      }
    },
  );

  it('repairs orphan work and pre-existing sent work after a partial installation', () => {
    const db = previousSchema();
    try {
      const now = new Date().toISOString();
      // Apply work registration before the sent/source-removal triggers exist.
      const statements = splitSqlStatements(migration);
      db.exec(statements.slice(0, 4).join(';'));
      db.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret)
        VALUES('a','a','synthetic','synthetic','synthetic');
        INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f','f','a');`);
      for (const id of ['removed', 'sent']) {
        db.prepare(`INSERT INTO pharmacy_myna_handoffs
          (id,line_account_id,friend_id,method,status,source,correlation_id,expires_at,created_at,updated_at)
          VALUES(?,'a','f','PAPER','EXPIRED','LIFF',?,?,?,?)`).run(id, id, now, now, now);
      }
      // Only synthetic in-memory source rows are removed to inject metadata drift.
      db.exec(`DELETE FROM pharmacy_myna_handoffs WHERE id='removed'`);
      db.prepare(`INSERT INTO pharmacy_notification_events
        (id,line_account_id,friend_id,message_id,category,outcome,occurred_at,idempotency_key,created_at)
        VALUES('notice','a','f','myna_handoff_status_v1','transactional_care','sent',?,'myna-status:sent:EXPIRED',?)`).run(
        now,
        now,
      );
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM pharmacy_status_notification_work WHERE state='pending'`).get(),
      ).toEqual({ n: 2 });
      db.exec(migration);
      expect(
        db.prepare(`SELECT source_id,state FROM pharmacy_status_notification_work ORDER BY source_id`).all(),
      ).toEqual([
        { source_id: 'removed', state: 'expired' },
        { source_id: 'sent', state: 'done' },
      ]);
    } finally {
      db.close();
    }
  });
});
