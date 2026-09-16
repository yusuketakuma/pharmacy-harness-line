import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAffiliateOffer,
  enrollAffiliateInOffer,
  setConversionApproval,
  updateAffiliateOffer,
} from '../src/affiliate-offers.js';
import {
  applyMileageRulesForEvent,
  createMileageRule,
  getMileageHistoryForFriend,
  getMileageSummaryForFriend,
  postMileageEntryIfUnderDailyCap,
  processPendingMileageEvents,
  syncAffiliateConversionMileage,
} from '../src/mileage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
  db.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-1', 'channel-1', 'A', 'token', 'secret')`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES ('user-1', 'User', '2026-01-01', '2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, user_id, line_account_id, created_at, updated_at)
     VALUES ('friend-1', 'U1', 'Friend', 'user-1', 'account-1', '2026-01-01', '2026-01-01')`,
  ).run();
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const stmt = sqlite.prepare(query);
          return {
            async run() {
              const info = stmt.run(...params);
              return { success: true, meta: { changes: info.changes }, results: [] };
            },
            async first<T>() {
              return (stmt.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { success: true, results: stmt.all(...params) as T[], meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('daily mileage cap', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
  });

  test('caps the grant inside the write so queued events cannot overshoot', async () => {
    const rule = await createMileageRule(db, {
      name: '1日1回まで',
      eventType: 'purchase_completed',
      source: 'stripe',
      amount: 10,
      conditions: { dailyCapActions: 1 },
    });

    await applyMileageRulesForEvent(db, {
      eventType: 'purchase_completed',
      source: 'stripe',
      sourceEventId: 'evt-1',
      friendId: 'friend-1',
    });
    await applyMileageRulesForEvent(db, {
      eventType: 'purchase_completed',
      source: 'stripe',
      sourceEventId: 'evt-2',
      friendId: 'friend-1',
    });

    // available_at is stamped with the real clock at enqueue time, so the drain
    // cutoff must be in the future to see the queued events.
    const drained = await processPendingMileageEvents(db, { now: '2099-01-01T00:00:00' });
    expect(drained.processed).toBe(2);

    const grants = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM mileage_ledger
          WHERE mileage_rule_id = ? AND entry_type = 'grant' AND status != 'void'`,
      )
      .get(rule.id) as { c: number };
    expect(grants.c).toBe(1);
  });

  test('cap applies per beneficiary/day and retries return the existing entry', async () => {
    const rule = await createMileageRule(db, {
      name: 'cap2',
      eventType: 'form_submitted',
      source: 'liff',
      amount: 5,
      conditions: { dailyCapActions: 2 },
    });
    const base = {
      beneficiaryFriendId: 'friend-1',
      mileageRuleId: rule.id,
      entryType: 'grant' as const,
      amount: 5,
      reason: 'cap2',
      source: 'liff',
      occurredAt: '2026-09-16T10:00:00+09:00',
      dailyCapActions: 2,
    };

    const first = await postMileageEntryIfUnderDailyCap(db, { ...base, idempotencyKey: 'k-1' });
    const second = await postMileageEntryIfUnderDailyCap(db, { ...base, idempotencyKey: 'k-2' });
    const third = await postMileageEntryIfUnderDailyCap(db, { ...base, idempotencyKey: 'k-3' });
    expect(first?.amount).toBe(5);
    expect(second?.amount).toBe(5);
    expect(third).toBeNull();

    // Same-key retry resolves to the existing entry instead of double posting.
    const retry = await postMileageEntryIfUnderDailyCap(db, { ...base, idempotencyKey: 'k-1' });
    expect(retry?.id).toBe(first?.id);

    // A different day has its own budget.
    const nextDay = await postMileageEntryIfUnderDailyCap(db, {
      ...base,
      idempotencyKey: 'k-4',
      occurredAt: '2026-09-17T10:00:00+09:00',
    });
    expect(nextDay?.amount).toBe(5);
  });
});

describe('affiliate offer program move', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = setupDb();
    db = asD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO mileage_programs (id, code, name, status, created_at, updated_at)
         VALUES ('program-b', 'program-b', 'Program B', 'active', '2026-01-01', '2026-01-01')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO affiliates (id, name, code, is_active, created_at, friend_id)
         VALUES ('aff-1', 'Affiliate', 'aff-1', 1, '2026-01-01', 'friend-1')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO conversion_points (id, name, event_type, value, created_at)
         VALUES ('cp-1', 'CP', 'purchase', 100, '2026-01-01')`,
      )
      .run();
  });

  test('rejection reverses the grant under its original program after the offer moved', async () => {
    const offer = await createAffiliateOffer(db, {
      name: '案件A',
      rewardAmount: 5000,
      rewardMiles: 750,
    });
    const { link } = await enrollAffiliateInOffer(db, {
      affiliateId: 'aff-1',
      offerId: offer.id,
    });
    sqlite
      .prepare(
        `INSERT INTO conversion_events
           (id, conversion_point_id, friend_id, affiliate_id, attributed_ref_code, approval_status, created_at)
         VALUES ('ce-1', 'cp-1', 'friend-1', 'aff-1', ?, 'pending', '2026-01-01')`,
      )
      .run(link.ref_code);

    expect(await setConversionApproval(db, 'ce-1', 'approved')).toBe(true);
    sqlite.prepare(`UPDATE conversion_events SET approved_at = '2026-01-02' WHERE id = 'ce-1'`).run();
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');
    expect(await getMileageSummaryForFriend(db, 'friend-1')).toMatchObject({ available: 750 });

    // Offer moved to another program namespace after the grant.
    await updateAffiliateOffer(db, offer.id, { mileage_program_id: 'program-b' });

    // Re-syncing the same approval must not post a second grant under program-b.
    await syncAffiliateConversionMileage(db, 'ce-1', 'approved');
    expect(
      (sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM mileage_ledger
            WHERE source = 'affiliate_conversion' AND source_event_id = 'ce-1' AND entry_type = 'grant'`,
        )
        .get() as { c: number }).c,
    ).toBe(1);

    // Rejection still finds and reverses the original program's grant.
    expect(await setConversionApproval(db, 'ce-1', 'rejected')).toBe(true);
    sqlite.prepare(`UPDATE conversion_events SET approved_at = '2026-01-03' WHERE id = 'ce-1'`).run();
    await syncAffiliateConversionMileage(db, 'ce-1', 'rejected');
    await syncAffiliateConversionMileage(db, 'ce-1', 'rejected');

    const history = await getMileageHistoryForFriend(db, 'friend-1');
    expect(history.map((item) => item.amount).sort((a, b) => a - b)).toEqual([-750, 750]);
    expect(await getMileageSummaryForFriend(db, 'friend-1')).toMatchObject({
      available: 0,
      lifetimeEarned: 750,
    });
    const reversalPrograms = sqlite
      .prepare(
        `SELECT DISTINCT program_id AS p FROM mileage_ledger WHERE entry_type = 'reversal'`,
      )
      .all() as { p: string }[];
    expect(reversalPrograms).toEqual([{ p: 'default' }]);
  });
});
