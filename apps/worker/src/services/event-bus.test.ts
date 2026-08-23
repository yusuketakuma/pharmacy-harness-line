import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from './event-bus.js';

const DB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/db');
const require = createRequire(import.meta.url);
type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => SqliteDatabase;

interface CapturedInsert {
  sql: string;
  binds: unknown[];
}

function fakeDb(opts: {
  friend?: { line_user_id: string; line_account_id?: string | null };
  capturedInserts: CapturedInsert[];
  pharmacyMode?: boolean;
  tenantId?: string;
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          if (sql.includes('INSERT INTO messages_log')) {
            opts.capturedInserts.push({ sql, binds: args });
          }
          return this;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM pharmacy_account_capabilities')) {
            return (opts.pharmacyMode ? { mode: 'pharmacy' } : null) as T | null;
          }
          if (sql.includes('FROM friends WHERE id')) {
            return (opts.friend ?? null) as T | null;
          }
          if (sql.includes('FROM tenant_line_accounts')) {
            return (opts.tenantId ? { tenant_id: opts.tenantId } : null) as T | null;
          }
          return null;
        },
        async run(): Promise<{ success: true }> {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
}

function deliveryDb(failSentSettlement = false): { db: D1Database; sqlite: SqliteDatabase } {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE pharmacy_account_capabilities (
      line_account_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL
    );
    CREATE TABLE tenant_line_accounts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (tenant_id, line_account_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
    );
    INSERT INTO tenants VALUES ('tenant-a');
    INSERT INTO line_accounts VALUES ('account-a');
    INSERT INTO tenant_line_accounts VALUES ('tenant-a', 'account-a');
    INSERT INTO pharmacy_account_capabilities VALUES ('account-a', 'generic');
  `);
  sqlite.exec(readFileSync(
    join(DB_ROOT, 'migrations/custom_053_outgoing_webhook_deliveries.sql'),
    'utf8',
  ));
  let rejectSent = failSentSettlement;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => {
      if (rejectSent && sql.includes('UPDATE outgoing_webhook_deliveries') && values[0] === 'sent') {
        rejectSent = false;
        throw new Error('synthetic D1 settlement failure');
      }
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: result.changes } };
    },
  });
  return {
    db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database,
    sqlite,
  };
}

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return {
    ...actual,
    getActiveOutgoingWebhooksByEvent: vi.fn().mockResolvedValue([]),
    applyScoring: vi.fn().mockResolvedValue(undefined),
    getActiveAutomationsByEvent: vi.fn(),
    createAutomationLog: vi.fn().mockResolvedValue(undefined),
    getActiveNotificationRulesByEvent: vi.fn().mockResolvedValue([]),
    createNotification: vi.fn().mockResolvedValue(undefined),
    addTagToFriend: vi.fn().mockResolvedValue(undefined),
    removeTagFromFriend: vi.fn().mockResolvedValue(undefined),
    enrollFriendInScenario: vi.fn().mockResolvedValue(undefined),
    jstNow: vi.fn(() => '2026-05-08T00:00:00.000+09:00'),
    getFriendScore: vi.fn().mockResolvedValue(0),
    getTemplateById: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@line-crm/line-sdk', () => {
  return {
    LineClient: vi.fn().mockImplementation(function () {
      return {
        replyMessage: vi.fn().mockResolvedValue(undefined),
        pushMessage: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

vi.mock('./ad-conversion.js', () => ({
  sendAdConversions: vi.fn().mockResolvedValue(undefined),
}));

describe('fireEvent — send_message action logging', () => {
  let captured: CapturedInsert[];

  beforeEach(async () => {
    captured = [];
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-1',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({ keyword: 'コスト比較' }),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              messageType: 'flex',
              content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"hi"}]}}',
              altText: 'hi',
            },
          },
        ]),
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs flex outgoing message to messages_log when send_message fires via reply', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
        replyToken: 'reply-token-xyz',
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    const insert = captured[0];
    expect(insert.sql).toContain('INSERT INTO messages_log');
    // bind order: id, friendId, messageType, content, deliveryType, source, lineAccountId, createdAt
    expect(insert.binds[1]).toBe('friend-1');
    expect(insert.binds[2]).toBe('flex');
    expect(insert.binds[4]).toBe('reply');
    expect(insert.binds[5]).toBe('automation');
    expect(insert.binds[6]).toBe('acc-1');
  });

  it('logs delivery_type=push when no replyToken provided', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[4]).toBe('push');
  });

  it('logs even when text message (not flex) is sent', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-2',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: { messageType: 'text', content: 'hello' },
          },
        ]),
      },
    ]);

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'tag_added',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[2]).toBe('text');
    expect(captured[0].binds[3]).toBe('hello');
    expect(captured[0].binds[6]).toBe(null);
  });

  it('does not run generic scoring or automations for a pharmacy account', async () => {
    const db = await import('@line-crm/db');
    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
      pharmacyMode: true,
    });

    await fireEvent(
      dbFake,
      'message_received',
      { friendId: 'friend-1', eventData: { text: 'コスト比較' } },
      'channel-token',
      'acc-1',
    );

    expect(db.applyScoring).not.toHaveBeenCalled();
    expect(db.getActiveAutomationsByEvent).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('derives the pharmacy account from the friend instead of trusting an omitted caller scope', async () => {
    const db = await import('@line-crm/db');
    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test', line_account_id: 'acc-1' },
      capturedInserts: captured,
      pharmacyMode: true,
    });

    await fireEvent(dbFake, 'message_received', { friendId: 'friend-1' }, 'channel-token');

    expect(db.applyScoring).not.toHaveBeenCalled();
    expect(db.getActiveAutomationsByEvent).not.toHaveBeenCalled();
  });

  it('scopes tenant-only events and does not run accountless automations', async () => {
    const db = await import('@line-crm/db');
    const dbFake = fakeDb({ capturedInserts: captured });

    await fireEvent(dbFake, 'incoming_webhook.custom', {}, undefined, null, 'tenant-a');

    expect(db.getActiveOutgoingWebhooksByEvent).toHaveBeenCalledWith(
      dbFake,
      'incoming_webhook.custom',
      'tenant-a',
    );
    expect(db.getActiveAutomationsByEvent).not.toHaveBeenCalled();
  });

  it('derives tenant scope from the server-resolved event account', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue([]);
    const dbFake = fakeDb({ capturedInserts: captured, tenantId: 'tenant-a' });

    await fireEvent(dbFake, 'tag_change', {}, undefined, 'acc-1');

    expect(db.getActiveOutgoingWebhooksByEvent).toHaveBeenCalledWith(
      dbFake,
      'tag_change',
      'tenant-a',
    );
  });

  it('revalidates a configured webhook URL at delivery time', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveOutgoingWebhooksByEvent as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce([{
        id: 'webhook-1',
        tenant_id: 'tenant-a',
        name: 'unsafe',
        url: 'http://internal.example/hook',
        event_types: '["tag_change"]',
        secret: null,
        is_active: 1,
      }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await fireEvent(
        fakeDb({ capturedInserts: captured }),
        'tag_change',
        {},
        undefined,
        null,
        'tenant-a',
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('passes a bounded deadline to configured webhook delivery', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveOutgoingWebhooksByEvent as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce([{
        id: 'webhook-1',
        tenant_id: 'tenant-a',
        name: 'safe',
        url: 'https://hooks.example.com/receive',
        event_types: '["tag_change"]',
        secret: null,
        is_active: 1,
      }]);
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await fireEvent(
        fakeDb({ capturedInserts: captured }),
        'tag_change',
        {},
        undefined,
        null,
        'tenant-a',
      );

      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://hooks.example.com/receive',
        expect.objectContaining({ redirect: 'manual', signal: controller.signal }),
      );
    } finally {
      timeout.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('records an automation webhook HTTP error as a failed action', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce([{
        id: 'automation-1',
        line_account_id: null,
        conditions: '{}',
        actions: JSON.stringify([{
          type: 'send_webhook',
          params: { url: 'https://hooks.example.com/receive' },
        }]),
      }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private upstream detail', { status: 503, statusText: 'Unavailable' }),
    );

    try {
      await fireEvent(fakeDb({ capturedInserts: captured }), 'tag_change', {});

      expect(db.createAutomationLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'failed' }),
      );
      const call = vi.mocked(db.createAutomationLog).mock.calls.at(-1);
      expect(JSON.stringify(call?.[1])).not.toContain('private upstream detail');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not resend after external success when D1 settlement is unknown', async () => {
    const dbModule = await import('@line-crm/db');
    const webhook = {
      id: 'webhook-1',
      tenant_id: 'tenant-a',
      name: 'safe',
      url: 'https://hooks.example.com/receive',
      event_types: '["message_received"]',
      secret: null,
      is_active: 1,
      created_at: '2026-08-23T00:00:00.000Z',
      updated_at: '2026-08-23T00:00:00.000Z',
    };
    vi.mocked(dbModule.getActiveOutgoingWebhooksByEvent)
      .mockResolvedValueOnce([webhook])
      .mockResolvedValueOnce([webhook]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { db, sqlite } = deliveryDb(true);

    try {
      await fireEvent(db, 'message_received', {}, undefined, null, 'tenant-a', 'source-event-1');
      await fireEvent(db, 'message_received', {}, undefined, null, 'tenant-a', 'source-event-1');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
      expect(headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u);
      expect(headers.get('X-Webhook-Delivery-Id')).toBe(headers.get('Idempotency-Key'));
      expect(sqlite.prepare(`SELECT outcome, claim_token IS NOT NULL AS claimed
        FROM outgoing_webhook_deliveries`).get()).toEqual({ outcome: 'attempted', claimed: 1 });
    } finally {
      fetchSpy.mockRestore();
      sqlite.close();
    }
  });

  it('keeps a 5xx outcome attempted and does not guess by resending', async () => {
    const dbModule = await import('@line-crm/db');
    const webhook = {
      id: 'webhook-1', tenant_id: 'tenant-a', name: 'safe',
      url: 'https://hooks.example.com/receive', event_types: '["message_received"]',
      secret: null, is_active: 1,
      created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z',
    };
    vi.mocked(dbModule.getActiveOutgoingWebhooksByEvent)
      .mockResolvedValueOnce([webhook])
      .mockResolvedValueOnce([webhook]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 503, statusText: 'Unavailable' }),
    );
    const { db, sqlite } = deliveryDb();

    try {
      await fireEvent(db, 'message_received', {}, undefined, null, 'tenant-a', 'source-event-1');
      await fireEvent(db, 'message_received', {}, undefined, null, 'tenant-a', 'source-event-1');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare(`SELECT outcome, http_status FROM outgoing_webhook_deliveries`).get())
        .toEqual({ outcome: 'attempted', http_status: null });
    } finally {
      fetchSpy.mockRestore();
      sqlite.close();
    }
  });

  it('retries a definite 4xx rejection with the same delivery id', async () => {
    const dbModule = await import('@line-crm/db');
    vi.mocked(dbModule.jstNow)
      .mockReturnValueOnce('2026-05-08T00:00:00.000+09:00')
      .mockReturnValueOnce('2026-05-08T00:00:01.000+09:00')
      .mockReturnValueOnce('2026-05-08T00:00:02.000+09:00')
      .mockReturnValueOnce('2026-05-08T00:00:03.000+09:00');
    const webhook = {
      id: 'webhook-1', tenant_id: 'tenant-a', name: 'safe',
      url: 'https://hooks.example.com/receive', event_types: '["message_received"]',
      secret: 'test-secret', is_active: 1,
      created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z',
    };
    vi.mocked(dbModule.getActiveOutgoingWebhooksByEvent)
      .mockResolvedValueOnce([webhook])
      .mockResolvedValueOnce([webhook]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { db, sqlite } = deliveryDb();

    try {
      await fireEvent(db, 'message_received', {}, undefined, null, 'tenant-a', 'source-event-1');
      await fireEvent(db, 'message_received', {}, undefined, null, 'tenant-a', 'source-event-1');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const firstHeaders = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
      const secondHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
      expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
      expect(secondHeaders.get('X-Webhook-Signature')).toBe(firstHeaders.get('X-Webhook-Signature'));
      expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(fetchSpy.mock.calls[0]?.[1]?.body);
      expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outgoing_webhook_deliveries`).get())
        .toEqual({ outcome: 'sent', attempt_count: 2 });
    } finally {
      fetchSpy.mockRestore();
      sqlite.close();
    }
  });

  it('deduplicates an automation send_webhook action by automation and action index', async () => {
    const dbModule = await import('@line-crm/db');
    const automation = {
      id: 'automation-1',
      line_account_id: 'account-a',
      conditions: '{}',
      actions: JSON.stringify([{
        type: 'send_webhook',
        params: { url: 'https://hooks.example.com/receive' },
      }]),
    };
    vi.mocked(dbModule.getActiveOutgoingWebhooksByEvent)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    vi.mocked(dbModule.getActiveAutomationsByEvent)
      .mockResolvedValueOnce([automation] as never[])
      .mockResolvedValueOnce([automation] as never[]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const { db, sqlite } = deliveryDb();

    try {
      await fireEvent(db, 'message_received', {}, undefined, 'account-a', 'tenant-a', 'source-event-1');
      await fireEvent(db, 'message_received', {}, undefined, 'account-a', 'tenant-a', 'source-event-1');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare(`SELECT target_type, target_id, outcome
        FROM outgoing_webhook_deliveries`).get()).toEqual({
        target_type: 'automation',
        target_id: 'automation-1:0',
        outcome: 'sent',
      });
    } finally {
      fetchSpy.mockRestore();
      sqlite.close();
    }
  });

  it('resolves params.template_id via templates table when set', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-tpl',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              template_id: 'tpl-1',
              // content / messageType を空にして template 経由 resolve を強制
            },
          },
        ]),
      },
    ]);
    (db.getTemplateById as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      id: 'tpl-1',
      name: 'test-tpl',
      category: 'general',
      message_type: 'flex',
      message_content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"from-template"}]}}',
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'manual_test',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    // log には template から取得した messageType / content が記録される
    expect(captured[0].binds[2]).toBe('flex');
    expect(String(captured[0].binds[3])).toContain('from-template');
  });
});
