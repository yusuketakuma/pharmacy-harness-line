import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceFriendScenario,
  claimFriendScenarioForDelivery,
  pauseFriendScenarioDelivery,
  recoverStuckDeliveries,
} from '../src/scenarios.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) { values = next; return statement; },
        async run() {
          const result = sqlite.prepare(sql).run(...values as Database.BindParameters);
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function jstIso(offsetMs: number): string {
  return new Date(Date.now() + 9 * 60 * 60_000 + offsetMs)
    .toISOString().slice(0, -1) + '+09:00';
}

describe('scenario delivery claim horizon', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db = asD1(sqlite);
  });

  function insertEnrollment(id: string, status: 'active' | 'delivering' | 'paused', firstAttemptedAt: string) {
    const friendId = `friend-${id}`;
    const scenarioId = `scenario-${id}`;
    sqlite.prepare(`INSERT INTO friends (id, line_user_id) VALUES (?, ?)`).run(friendId, `U-${id}`);
    sqlite.prepare(`INSERT INTO scenarios (id, name, trigger_type) VALUES (?, 'Test', 'manual')`).run(scenarioId);
    sqlite.prepare(`INSERT INTO friend_scenarios
      (id, friend_id, scenario_id, current_step_order, status, started_at,
       next_delivery_at, updated_at, delivery_first_attempted_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
      id, friendId, scenarioId, status, jstIso(-48 * 60 * 60_000), jstIso(-30 * 60_000),
      jstIso(-10 * 60_000), firstAttemptedAt,
    );
  }

  it('does not reclaim an active step after the LINE retry-key horizon', async () => {
    insertEnrollment('expired-active', 'active', jstIso(-25 * 60 * 60_000));

    await expect(claimFriendScenarioForDelivery(db, 'expired-active', 0)).resolves.toBeNull();
  });

  it('recovers a fresh claim and pauses an expired unknown outcome', async () => {
    insertEnrollment('fresh', 'delivering', jstIso(-60 * 60_000));
    insertEnrollment('expired', 'delivering', jstIso(-25 * 60 * 60_000));

    await expect(recoverStuckDeliveries(db)).resolves.toBe(1);
    expect(sqlite.prepare(`SELECT id, status FROM friend_scenarios ORDER BY id`).all()).toEqual([
      { id: 'expired', status: 'paused' },
      { id: 'fresh', status: 'active' },
    ]);
  });

  it('keeps a reply claim paused across stale-delivery recovery', async () => {
    insertEnrollment('reply-unknown', 'active', jstIso(-60_000));
    const claimToken = await claimFriendScenarioForDelivery(db, 'reply-unknown', 0);
    expect(claimToken).toEqual(expect.any(String));

    await expect(
      pauseFriendScenarioDelivery(db, 'reply-unknown', claimToken as string),
    ).resolves.toBe(true);
    sqlite.prepare(`UPDATE friend_scenarios SET updated_at = ? WHERE id = ?`)
      .run(jstIso(-10 * 60_000), 'reply-unknown');

    await expect(recoverStuckDeliveries(db)).resolves.toBe(0);
    expect(sqlite.prepare(`SELECT status FROM friend_scenarios WHERE id = ?`)
      .get('reply-unknown')).toEqual({ status: 'paused' });
  });

  it('does not let a stale worker pause a replacement claim', async () => {
    insertEnrollment('stale-owner', 'active', jstIso(-60 * 60_000));

    const staleToken = await claimFriendScenarioForDelivery(db, 'stale-owner', 0);
    expect(staleToken).toEqual(expect.any(String));
    sqlite.prepare(`UPDATE friend_scenarios SET updated_at = ? WHERE id = ?`)
      .run(jstIso(-10 * 60_000), 'stale-owner');

    await expect(recoverStuckDeliveries(db)).resolves.toBe(1);
    const replacementToken = await claimFriendScenarioForDelivery(db, 'stale-owner', 0);
    expect(replacementToken).toEqual(expect.any(String));
    expect(replacementToken).not.toBe(staleToken);

    await expect(
      pauseFriendScenarioDelivery(db, 'stale-owner', staleToken as string),
    ).resolves.toBe(false);
    expect(sqlite.prepare(`SELECT status, delivery_claim_token
      FROM friend_scenarios WHERE id = ?`).get('stale-owner')).toEqual({
      status: 'delivering',
      delivery_claim_token: replacementToken,
    });
  });

  it('does not let a stale worker rewind a replacement projection', async () => {
    insertEnrollment('stale-advance', 'active', jstIso(-60 * 60_000));
    const staleToken = await claimFriendScenarioForDelivery(db, 'stale-advance', 0);
    expect(staleToken).toEqual(expect.any(String));
    sqlite.prepare(`UPDATE friend_scenarios SET updated_at = ? WHERE id = ?`)
      .run(jstIso(-10 * 60_000), 'stale-advance');

    await expect(recoverStuckDeliveries(db)).resolves.toBe(1);
    const replacementToken = await claimFriendScenarioForDelivery(db, 'stale-advance', 0);
    expect(replacementToken).toEqual(expect.any(String));
    await expect(advanceFriendScenario(
      db,
      'stale-advance',
      2,
      null,
      { token: replacementToken as string, expectedStepOrder: 0 },
    )).resolves.toBe(true);

    await expect(advanceFriendScenario(
      db,
      'stale-advance',
      1,
      null,
      { token: staleToken as string, expectedStepOrder: 0 },
    )).resolves.toBe(false);
    expect(sqlite.prepare(`SELECT current_step_order, status
      FROM friend_scenarios WHERE id = ?`).get('stale-advance')).toEqual({
      current_step_order: 2,
      status: 'active',
    });
  });
});
