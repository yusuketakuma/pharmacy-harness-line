import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn().mockResolvedValue(true),
    LineClient: vi.fn().mockImplementation(function () { return lineClientMocks; }),
  };
});

vi.mock('../../custom/pharmacy/provisioning/line-credential-store.js', () => ({
  readLineCredential: vi.fn(async (_db: unknown, _root: unknown, input: { kind: string }) =>
    input.kind === 'channel_secret' ? 'channel-secret' : 'channel-access-token'),
}));

vi.mock('../../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

import { toJstString } from '@line-crm/db';

import { purgeWebhookEventReceipts, sweepWebhookInbox, webhook } from './webhook.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/db');
const require = createRequire(import.meta.url);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type Sqlite3Database = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => Sqlite3Database;

/** Adapts better-sqlite3 to the D1 surface the worker uses. */
function d1From(sqlite: Sqlite3Database, failOn?: (sql: string) => boolean): D1Database {
  const guard = (sql: string) => {
    if (failOn?.(sql)) throw new Error(`SIMULATED_D1_FAILURE: ${sql.slice(0, 40)}`);
  };
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      guard(sql);
      return sqlite.prepare(sql).get(...values) ?? null;
    },
    all: async () => {
      guard(sql);
      return { success: true, results: sqlite.prepare(sql).all(...values), meta: {} };
    },
    run: async () => {
      guard(sql);
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
  } as unknown as D1Database;
}

function seedTenant(sqlite: Sqlite3Database, suffix: 'a' | 'b'): void {
  const now = '2026-08-19T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`account-${suffix}`, `channel-${suffix}`, suffix, `token-${suffix}`, `secret-${suffix}`, now, now);
  sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`)
    .run(`tenant-${suffix}`, `pharmacy-${suffix}`, `Tenant ${suffix}`, now, now);
  sqlite.prepare(`INSERT INTO tenant_line_accounts (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`)
    .run(`tenant-${suffix}`, `account-${suffix}`, now, now);
  sqlite.prepare(`INSERT INTO pharmacy_line_channel_identities (line_account_id, bot_user_id, created_at)
    VALUES (?, ?, ?)`)
    .run(`account-${suffix}`, `bot-${suffix}`, now);
  sqlite.prepare(`INSERT INTO friends
    (id, line_user_id, line_account_id, is_following, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)`)
    .run(`friend-${suffix}`, `U-${suffix}`, `account-${suffix}`, now, now);
}

function textEvent(suffix: 'a' | 'b', webhookEventId: string) {
  return {
    type: 'message',
    replyToken: `reply-${webhookEventId}`,
    message: { type: 'text', id: `message-${webhookEventId}`, text: 'こんにちは' },
    timestamp: 1_755_000_000_000,
    source: { type: 'user', userId: `U-${suffix}` },
    webhookEventId,
    deliveryContext: { isRedelivery: false },
    mode: 'active',
  };
}

function imageEvent(suffix: 'a' | 'b', webhookEventId: string, messageId: string) {
  return {
    type: 'message',
    replyToken: `reply-${webhookEventId}`,
    message: { type: 'image', id: messageId },
    timestamp: 1_755_000_000_000,
    source: { type: 'user', userId: `U-${suffix}` },
    webhookEventId,
    deliveryContext: { isRedelivery: false },
    mode: 'active',
  };
}

function makeR2Stub(): R2Bucket {
  return {
    put: vi.fn(async () => null),
  } as unknown as R2Bucket;
}

/** Mirrors WEBHOOK_INBOX_MAX_ATTEMPTS in webhook.ts. */
const WEBHOOK_ATTEMPT_CAP = 10;

const ENV = {
  LINE_CREDENTIAL_KEY_V1: 'root-key-for-durable-inbox-tests-v1',
  WORKER_URL: 'https://worker.example.com',
  LIFF_URL: 'https://liff.line.me/1234-abcd',
} as const;

function post(
  db: D1Database,
  suffix: 'a' | 'b',
  events: unknown[],
  executionCtx: ExecutionContext,
  envOverrides: Record<string, unknown> = {},
) {
  const app = new Hono();
  app.route('/', webhook);
  return app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': `${'A'.repeat(43)}=` },
    body: JSON.stringify({ destination: `bot-${suffix}`, events }),
  }, { ...ENV, DB: db, ...envOverrides }, executionCtx);
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { pending.push(p); }),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.allSettled(pending) };
}

describe('webhook durable inbox (H-3)', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;

  const receipts = () => sqlite.prepare(
    `SELECT tenant_id, line_account_id, webhook_event_id, payload, status,
            lease_until, retry_count, dead_lettered_at
       FROM pharmacy_webhook_event_receipts
      ORDER BY tenant_id, webhook_event_id`,
  ).all() as Array<{
    tenant_id: string; line_account_id: string; webhook_event_id: string;
    payload: string | null; status: string; lease_until: string | null;
    retry_count: number; dead_lettered_at: string | null;
  }>;

  const incomingMessages = () => sqlite.prepare(
    `SELECT id, friend_id, content FROM messages_log WHERE direction = 'incoming'`,
  ).all() as Array<{ id: string; friend_id: string; content: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    seedTenant(sqlite, 'a');
    seedTenant(sqlite, 'b');
    db = d1From(sqlite);
  });

  test('stores the full event body before the 200 ACK', async () => {
    const { ctx, settle } = makeCtx();
    const response = await post(db, 'a', [textEvent('a', 'event-1')], ctx);

    expect(response.status).toBe(200);
    // Durable at ACK time: body present, keyed to this tenant and account.
    const [row] = receipts();
    expect(row).toMatchObject({
      tenant_id: 'tenant-a',
      line_account_id: 'account-a',
      webhook_event_id: 'event-1',
    });
    expect(JSON.parse(row.payload!)).toMatchObject({ webhookEventId: 'event-1' });

    await settle();
    expect(receipts()[0]).toMatchObject({ status: 'completed', lease_until: null });
    expect(incomingMessages()).toHaveLength(1);
  });

  test('fails the request when the durable write fails instead of acking a lost event', async () => {
    const failing = d1From(sqlite, (sql) => sql.includes('INSERT OR IGNORE INTO pharmacy_webhook_event_receipts'));
    const { ctx, settle } = makeCtx();

    const response = await post(failing, 'a', [textEvent('a', 'event-lost')], ctx);

    expect(response.status).toBe(500);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(0);
    await settle();
  });

  test('a pending row left behind by a dead isolate is completed by the cron sweep', async () => {
    // Kill the request-time attempt at the claim, exactly where an evicted
    // isolate would stop: the row is stored, nothing has processed it.
    const dying = d1From(sqlite, (sql) => sql.includes("SET status = 'processing'"));
    const { ctx, settle } = makeCtx();

    const response = await post(dying, 'a', [textEvent('a', 'event-orphan')], ctx);
    await settle();

    expect(response.status).toBe(200);
    expect(receipts()[0]).toMatchObject({ status: 'pending', retry_count: 0 });
    expect(incomingMessages()).toHaveLength(0);

    const swept = await sweepWebhookInbox({
      db,
      credentialRootSecret: ENV.LINE_CREDENTIAL_KEY_V1,
      workerUrl: ENV.WORKER_URL,
    });

    expect(swept).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(receipts()[0]).toMatchObject({ status: 'completed', retry_count: 1 });
    expect(incomingMessages()).toHaveLength(1);
  });

  test('the same webhookEventId delivered twice produces exactly one effect', async () => {
    const first = makeCtx();
    await post(db, 'a', [textEvent('a', 'event-dup')], first.ctx);
    await first.settle();

    const second = makeCtx();
    const response = await post(db, 'a', [textEvent('a', 'event-dup')], second.ctx);
    await second.settle();

    expect(response.status).toBe(200);
    expect(receipts()).toHaveLength(1);
    expect(incomingMessages()).toHaveLength(1);

    // A later sweep must not resurrect a completed event either.
    await sweepWebhookInbox({ db, credentialRootSecret: ENV.LINE_CREDENTIAL_KEY_V1 });
    expect(incomingMessages()).toHaveLength(1);
  });

  test('a receipt for tenant A does not suppress the same webhookEventId for tenant B', async () => {
    const a = makeCtx();
    await post(db, 'a', [textEvent('a', 'shared-event-id')], a.ctx);
    await a.settle();

    const b = makeCtx();
    await post(db, 'b', [textEvent('b', 'shared-event-id')], b.ctx);
    await b.settle();

    expect(receipts().map((row) => [row.tenant_id, row.status])).toEqual([
      ['tenant-a', 'completed'],
      ['tenant-b', 'completed'],
    ]);
    expect(incomingMessages().map((row) => row.friend_id).sort()).toEqual(['friend-a', 'friend-b']);
  });

  test('a failing event is retried, then dead-lettered at the attempt cap', async () => {
    const now = new Date('2026-08-19T10:00:00.000Z');
    // An unparseable payload is a permanently failing event: it can never
    // succeed, so it must retire instead of being retried forever.
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count)
       VALUES ('tenant-a', 'account-a', 'event-broken', '2026-08-19T00:00:00.000+09:00', 'not-json', 'pending', 0)`,
    ).run();

    for (let attempt = 1; attempt <= WEBHOOK_ATTEMPT_CAP; attempt++) {
      const result = await sweepWebhookInbox({
        db,
        credentialRootSecret: ENV.LINE_CREDENTIAL_KEY_V1,
        now: new Date(now.getTime() + attempt * 10 * 60_000),
      });
      expect(result.failed).toBe(1);
    }

    const beforeRetire = receipts()[0];
    expect(beforeRetire).toMatchObject({ status: 'failed', retry_count: WEBHOOK_ATTEMPT_CAP });

    const retiring = await sweepWebhookInbox({
      db,
      credentialRootSecret: ENV.LINE_CREDENTIAL_KEY_V1,
      now: new Date(now.getTime() + 24 * 60 * 60_000),
    });
    expect(retiring.deadLettered).toBe(1);
    expect(retiring.claimed).toBe(0);
    expect(receipts()[0].dead_lettered_at).not.toBeNull();
  });

  test('a pending row stale for over 24h is dead-lettered without touching its payload', async () => {
    const now = new Date('2026-08-19T10:00:00.000Z');
    const stalePayload = JSON.stringify({ webhookEventId: 'event-stale' });
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count)
       VALUES ('tenant-a', 'account-a', 'event-stale', ?, ?, 'pending', 0)`,
    ).run(toJstString(new Date(now.getTime() - 25 * 60 * 60_000)), stalePayload);
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count)
       VALUES ('tenant-a', 'account-a', 'event-fresh', ?, '{}', 'pending', 0)`,
    ).run(toJstString(new Date(now.getTime() - 1 * 60 * 60_000)));
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count)
       VALUES ('tenant-a', 'account-a', 'event-old-completed', ?, '{}', 'completed', 0)`,
    ).run(toJstString(new Date(now.getTime() - 400 * 60 * 60_000)));
    // Stale but still under the attempt cap and mid-retry — must keep its retry path.
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count)
       VALUES ('tenant-a', 'account-a', 'event-failed-retrying', ?, '{}', 'failed', 3)`,
    ).run(toJstString(new Date(now.getTime() - 25 * 60 * 60_000)));
    // Stale but currently leased (being processed right now) — must not be
    // dead-lettered mid-flight.
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, retry_count, lease_until)
       VALUES ('tenant-a', 'account-a', 'event-leased', ?, '{}', 'processing', 1, ?)`,
    ).run(
      toJstString(new Date(now.getTime() - 25 * 60 * 60_000)),
      toJstString(new Date(now.getTime() + 5 * 60_000)),
    );

    const swept = await sweepWebhookInbox({ db, now });

    expect(swept.deadLettered).toBe(1);

    const byId = Object.fromEntries(receipts().map((row) => [row.webhook_event_id, row]));
    expect(byId['event-stale']).toMatchObject({ status: 'pending', retry_count: 0 });
    expect(byId['event-stale'].dead_lettered_at).not.toBeNull();
    expect(byId['event-stale'].payload).toBe(stalePayload);
    expect(byId['event-fresh']).toMatchObject({ status: 'pending', retry_count: 0, dead_lettered_at: null });
    expect(byId['event-old-completed']).toMatchObject({ status: 'completed', dead_lettered_at: null });
    expect(byId['event-failed-retrying']).toMatchObject({ status: 'failed', retry_count: 3, dead_lettered_at: null });
    expect(byId['event-leased']).toMatchObject({ status: 'processing', retry_count: 1, dead_lettered_at: null });
  });
});

describe('webhook receipt purge (M-7)', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;
  const NOW = new Date('2026-08-19T00:00:00.000Z');

  function insertReceipt(
    webhookEventId: string,
    daysAgo: number,
    status: string,
    deadLetteredAt: string | null = null,
  ): void {
    const receivedAt = new Date(NOW.getTime() - daysAgo * 86_400_000 + 9 * 60 * 60_000)
      .toISOString().slice(0, -1) + '+09:00';
    sqlite.prepare(
      `INSERT INTO pharmacy_webhook_event_receipts
         (tenant_id, line_account_id, webhook_event_id, received_at, payload, status, dead_lettered_at)
       VALUES ('tenant-a', 'account-a', ?, ?, '{}', ?, ?)`,
    ).run(webhookEventId, receivedAt, status, deadLetteredAt);
  }

  const remaining = () => (sqlite.prepare(
    `SELECT webhook_event_id FROM pharmacy_webhook_event_receipts ORDER BY webhook_event_id`,
  ).all() as Array<{ webhook_event_id: string }>).map((row) => row.webhook_event_id);

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    seedTenant(sqlite, 'a');
    db = d1From(sqlite);
  });

  test('removes settled rows past the retention window and keeps everything else', async () => {
    insertReceipt('completed-29d', 29, 'completed');
    insertReceipt('completed-31d', 31, 'completed');
    insertReceipt('dead-31d', 31, 'failed', '2026-07-19T00:00:00.000+09:00');
    insertReceipt('pending-31d', 31, 'pending');
    insertReceipt('pending-400d', 400, 'pending');
    insertReceipt('processing-400d', 400, 'processing');

    const deleted = await purgeWebhookEventReceipts(db, { now: NOW });

    expect(deleted).toBe(2);
    expect(remaining()).toEqual([
      'completed-29d', 'pending-31d', 'pending-400d', 'processing-400d',
    ]);
  });
});

describe('incoming image R2 key tracking (NEXT-4)', () => {
  let sqlite: Sqlite3Database;
  let db: D1Database;
  let originalFetch: typeof fetch;

  const trackedObjects = () => sqlite.prepare(
    `SELECT r2_key, tenant_id, line_account_id, message_id, stored_at
       FROM pharmacy_incoming_image_objects`,
  ).all() as Array<{
    r2_key: string; tenant_id: string; line_account_id: string;
    message_id: string; stored_at: string;
  }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Sqlite(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    seedTenant(sqlite, 'a');
    db = d1From(sqlite);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(new ArrayBuffer(10), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a stored incoming image produces exactly one tracking row', async () => {
    const r2 = makeR2Stub();
    const { ctx, settle } = makeCtx();

    const response = await post(
      db, 'a', [imageEvent('a', 'event-img-1', 'message-img-1')], ctx,
      { IMAGES: r2 },
    );
    await settle();

    expect(response.status).toBe(200);
    const rows = trackedObjects();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      line_account_id: 'account-a',
      message_id: 'message-img-1',
      r2_key: 'tenants/tenant-a/accounts/account-a/incoming/message-img-1.jpg',
    });
    expect(rows[0].stored_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('a tracking insert failure leaves the event retryable until the R2 key is tracked', async () => {
    const r2 = makeR2Stub();
    const failing = d1From(sqlite, (sql) => sql.includes('pharmacy_incoming_image_objects'));
    const { ctx, settle } = makeCtx();

    const response = await post(
      failing, 'a', [imageEvent('a', 'event-img-2', 'message-img-2')], ctx,
      { IMAGES: r2 },
    );
    await settle();

    expect(response.status).toBe(200);
    expect(trackedObjects()).toHaveLength(0);
    expect(sqlite.prepare(
      `SELECT status FROM pharmacy_webhook_event_receipts WHERE webhook_event_id = 'event-img-2'`,
    ).get()).toEqual({ status: 'failed' });
    expect(sqlite.prepare(
      `SELECT content FROM messages_log WHERE direction = 'incoming'`,
    ).all()).toHaveLength(0);

    const retried = await sweepWebhookInbox({
      db,
      credentialRootSecret: ENV.LINE_CREDENTIAL_KEY_V1,
      workerUrl: ENV.WORKER_URL,
      r2,
      now: new Date('2026-08-22T00:00:00.000Z'),
    });

    expect(retried).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(trackedObjects()).toHaveLength(1);
    expect(sqlite.prepare(
      `SELECT content FROM messages_log WHERE direction = 'incoming'`,
    ).all()).toHaveLength(1);
  });
});
