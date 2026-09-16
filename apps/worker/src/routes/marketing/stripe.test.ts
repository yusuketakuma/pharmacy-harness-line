import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../index.js';
import { DB_PACKAGE_ROOT, Sqlite, d1FromSqlite } from '../../custom/pharmacy/test-sqlite.js';
import { stripe } from './stripe.js';

function setup() {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(DB_PACKAGE_ROOT, 'bootstrap.sql'), 'utf8'));
  sqlite
    .prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a','channel-a','Synthetic','synthetic-token','synthetic-secret')`)
    .run();
  sqlite
    .prepare(`INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id)
      VALUES ('friend-a','line-user-a','user-a','account-a')`)
    .run();
  sqlite
    .prepare(`INSERT INTO scoring_rules (id, name, event_type, score_value, is_active, created_at, updated_at)
      VALUES ('rule-a','購入加点','purchase',10,1,'2026-01-01','2026-01-01')`)
    .run();
  return sqlite;
}

function webhookBody() {
  return JSON.stringify({
    id: 'evt-1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi-1',
        amount: 5000,
        currency: 'jpy',
        metadata: { line_friend_id: 'friend-a', product_id: 'prod-1' },
      },
    },
  });
}

describe('stripe webhook receipt/effect split', () => {
  it('re-runs effects on retry after a mid-handler failure instead of locking them out', async () => {
    const sqlite = setup();
    const base = d1FromSqlite(sqlite);
    let failScore = true;
    const db = {
      ...base,
      // addScore commits its ledger insert + cache update via db.batch(), so the
      // synthetic failure has to land on the batch that carries friend_scores.
      async batch(statements: Array<{ __sql?: string }>) {
        if (
          failScore &&
          statements.some((s) => s.__sql?.includes('INSERT OR IGNORE INTO friend_scores'))
        ) {
          failScore = false;
          throw new Error('synthetic scoring failure');
        }
        return base.batch(statements as D1PreparedStatement[]);
      },
    } as D1Database;

    const app = new Hono();
    app.route('/', stripe);
    const post = () =>
      app.fetch(
        new Request('https://example.invalid/api/integrations/stripe/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: webhookBody(),
        }),
        { DB: db } as never,
      );

    // First delivery: receipt committed, scoring blew up → 500.
    expect((await post()).status).toBe(500);
    const receipt = sqlite
      .prepare(`SELECT effects_completed_at FROM stripe_events WHERE stripe_event_id = 'evt-1'`)
      .get() as { effects_completed_at: string | null };
    expect(receipt.effects_completed_at).toBeNull();
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM friend_scores`).get() as { c: number }).c,
    ).toBe(0);

    // Stripe retry: effects resume instead of being swallowed by the receipt.
    const retry = await post();
    expect(retry.status).toBe(200);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM friend_scores`).get() as { c: number }).c,
    ).toBe(1);
    expect(
      (sqlite.prepare(`SELECT score FROM friends WHERE id = 'friend-a'`).get() as { score: number })
        .score,
    ).toBe(10);
    const done = sqlite
      .prepare(`SELECT effects_completed_at FROM stripe_events WHERE stripe_event_id = 'evt-1'`)
      .get() as { effects_completed_at: string | null };
    expect(done.effects_completed_at).not.toBeNull();

    // Further redeliveries short-circuit without doubling the score.
    const again = await post();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ data: { message: 'Already processed' } });
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM friend_scores`).get() as { c: number }).c,
    ).toBe(1);
    expect(
      (
        sqlite
          .prepare(`SELECT COUNT(*) AS c FROM engagement_events WHERE source_event_id = 'evt-1'`)
          .get() as { c: number }
      ).c,
    ).toBe(1);
  });

  it('does not double-apply effects when the completion marker write itself fails', async () => {
    const sqlite = setup();
    const base = d1FromSqlite(sqlite);
    let failCompletion = true;
    const db = {
      ...base,
      prepare(sql: string) {
        const prepared = base.prepare(sql);
        return {
          ...prepared,
          bind(...args: unknown[]) {
            const bound = prepared.bind(...args);
            if (!sql.includes('effects_completed_at')) return bound;
            return {
              ...bound,
              async run() {
                if (failCompletion) {
                  failCompletion = false;
                  throw new Error('synthetic completion-marker failure');
                }
                return bound.run();
              },
            };
          },
        };
      },
    } as D1Database;

    const app = new Hono();
    app.route('/', stripe);
    const post = () =>
      app.fetch(
        new Request('https://example.invalid/api/integrations/stripe/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: webhookBody(),
        }),
        { DB: db } as never,
      );

    // First delivery: every effect applied, then the completion marker blew up.
    expect((await post()).status).toBe(500);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM friend_scores`).get() as { c: number }).c,
    ).toBe(1);

    // The retry re-runs every effect; dedupe keys keep each exactly-once.
    expect((await post()).status).toBe(200);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS c FROM friend_scores`).get() as { c: number }).c,
    ).toBe(1);
    expect(
      (sqlite.prepare(`SELECT score FROM friends WHERE id = 'friend-a'`).get() as { score: number })
        .score,
    ).toBe(10);
    expect(
      (
        sqlite
          .prepare(`SELECT COUNT(*) AS c FROM engagement_events WHERE source_event_id = 'evt-1'`)
          .get() as { c: number }
      ).c,
    ).toBe(1);
  });

  it('scopes the events list to the authenticated tenant', async () => {
    const sqlite = setup();
    // A second tenant with its own account/friend and a stripe event each.
    sqlite
      .prepare("INSERT INTO tenants (id, tenant_code, display_name) VALUES ('tenant-a', 'tenant-a', 'tenant-a'), ('tenant-b', 'tenant-b', 'tenant-b')")
      .run();
    sqlite
      .prepare("INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('account-b','channel-b','B','synthetic-token','synthetic-secret')")
      .run();
    sqlite
      .prepare("INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES ('tenant-a', 'account-a'), ('tenant-b', 'account-b')")
      .run();
    sqlite
      .prepare("INSERT INTO friends (id, line_user_id, provider_line_user_id, line_account_id) VALUES ('friend-b','line-user-b','user-b','account-b')")
      .run();
    const db = d1FromSqlite(sqlite);
    const { createStripeEvent } = await import('@line-crm/db');
    await createStripeEvent(db, { stripeEventId: 'evt-a', eventType: 'payment_intent.succeeded', friendId: 'friend-a', amount: 100 });
    await createStripeEvent(db, { stripeEventId: 'evt-b', eventType: 'payment_intent.succeeded', friendId: 'friend-b', amount: 200 });

    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.route('/', stripe);

    const res = await app.fetch(
      new Request('https://example.invalid/api/integrations/stripe/events'),
      { DB: db } as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ stripeEventId: string }> };
    expect(body.data.map((e) => e.stripeEventId)).toEqual(['evt-a']);
  });
});
