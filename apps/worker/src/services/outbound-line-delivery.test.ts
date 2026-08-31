import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimFriendScenarioForDelivery,
  markFriendScenarioDeliveryAttempt,
  pauseFriendScenarioDelivery,
} from '@line-crm/db';
import {
  deliverTrackedLineBroadcast,
  deliverTrackedLineReply,
  deliverTrackedLinePush,
  reconcileAttemptedBroadcastTestPushes,
  reconcileAcceptedScenarioReplies,
  reconcileUnsentScenarioReplies,
  retireExpiredOutboundLineDeliveries,
} from './outbound-line-delivery.js';

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
  transaction<T>(fn: () => T): () => T;
};
const Sqlite = require(join(DB_ROOT, 'node_modules/better-sqlite3')) as
  new (filename: string) => SqliteDatabase;

function d1From(
  sqlite: SqliteDatabase,
  failBatchNumber?: number,
  failRunSql?: string,
  beforeRun?: (sql: string) => void,
  failFirstSql?: string,
  failAfterRunSql?: string,
  failAfterBatchNumber?: number,
  failFirstAfterRunSql?: string,
): D1Database {
  let batchNumber = 0;
  let runFailureUsed = false;
  let firstFailureUsed = false;
  let afterRunFailureUsed = false;
  let firstAfterRunFailureUsed = false;
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      if (failFirstAfterRunSql && afterRunFailureUsed && !firstAfterRunFailureUsed
        && sql.includes(failFirstAfterRunSql)) {
        firstAfterRunFailureUsed = true;
        throw new Error('synthetic D1 read-back failure');
      }
      if (failFirstSql && !firstFailureUsed && sql.includes(failFirstSql)) {
        firstFailureUsed = true;
        throw new Error('synthetic D1 first failure');
      }
      return sqlite.prepare(sql).get(...values) ?? null;
    },
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...values), meta: {} }),
    run: async () => {
      beforeRun?.(sql);
      if (failRunSql && !runFailureUsed && sql.includes(failRunSql)) {
        runFailureUsed = true;
        throw new Error('synthetic D1 run failure');
      }
      const result = sqlite.prepare(sql).run(...values);
      if (failAfterRunSql && !afterRunFailureUsed && sql.includes(failAfterRunSql)) {
        afterRunFailureUsed = true;
        throw new Error('synthetic D1 response loss after commit');
      }
      return { success: true, meta: { changes: result.changes } };
    },
    __run: () => {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: result.changes } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ __run: () => D1Result }>) => {
      batchNumber++;
      if (batchNumber === failBatchNumber) {
        throw new Error('synthetic D1 settlement failure');
      }
      const results = sqlite.transaction(() => statements.map((item) => item.__run()))();
      if (batchNumber === failAfterBatchNumber) {
        throw new Error('synthetic D1 batch response loss after commit');
      }
      return results;
    },
  } as unknown as D1Database;
}

describe('tracked LINE push settlement', () => {
  let sqlite: SqliteDatabase;

  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    sqlite.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO tenants (id, tenant_code, display_name, status)
        VALUES ('tenant-a', 'a', 'A', 'active');
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active)
        VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', 1);
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id)
        VALUES ('tenant-a', 'account-a');
      INSERT INTO friends
        (id, line_user_id, provider_line_user_id, line_account_id, is_following)
        VALUES ('friend-a', 'legacy-a', 'U-a', 'account-a', 1);
    `);
  });

  it('reuses the provider key and writes one log after external success then D1 failure', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const firstNow = new Date('2026-08-30T00:00:00.000Z');
    const params = {
      operationId: '11111111-1111-5111-8111-111111111111',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'hello',
      source: 'automation',
      request: { to: 'U-a', messages: [{ type: 'text' as const, text: 'hello' }] },
      send,
    };

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite, 2),
      now: firstNow,
      ...params,
    })).rejects.toThrow('OUTBOUND_LINE_SETTLEMENT_FAILED');

    expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'open', attempt_count: 1 });
    const deadline = sqlite.prepare(`SELECT created_at, retry_until FROM outbound_line_deliveries`)
      .get() as { created_at: string; retry_until: string };
    expect(Date.parse(deadline.retry_until) - Date.parse(deadline.created_at))
      .toBe(24 * 3600_000 - 60_000);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get())
      .toEqual({ count: 0 });

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite),
      now: new Date(firstNow.getTime() + 16 * 60_000),
      ...params,
      request: { to: 'U-changed', messages: [{ type: 'text', text: 'changed' }] },
    })).resolves.toBe('sent');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(send.mock.calls[1]?.[0]).toEqual(params.request);
    expect(send.mock.calls[1]?.[1]).toBe(send.mock.calls[0]?.[1]);
    expect(send.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', attempt_count: 2 });
    expect(sqlite.prepare(`SELECT id, line_account_id, outbound_operation_id FROM messages_log`).all())
      .toEqual([{
        id: params.operationId,
        line_account_id: 'account-a',
        outbound_operation_id: params.operationId,
      }]);
  });

  it('reuses a frozen provider broadcast after external success then D1 failure', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const firstNow = new Date('2026-08-30T00:00:00.000Z');
    const params = {
      operationId: '12121212-1212-5212-8212-121212121212',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      request: { messages: [{ type: 'text' as const, text: 'frozen broadcast' }] },
      send,
    };

    await expect(deliverTrackedLineBroadcast({
      ...params,
      db: d1From(sqlite, undefined, "SET outcome = 'accepted'"),
      now: firstNow,
    })).rejects.toThrow('OUTBOUND_LINE_SETTLEMENT_FAILED');

    expect(sqlite.prepare(
      `SELECT outcome, delivery_type, attempt_count, request_json
         FROM outbound_line_deliveries`,
    ).get()).toEqual({
      outcome: 'open',
      delivery_type: 'broadcast',
      attempt_count: 1,
      request_json: JSON.stringify(params.request),
    });

    await expect(deliverTrackedLineBroadcast({
      ...params,
      db: d1From(sqlite),
      now: new Date(firstNow.getTime() + 16 * 60_000),
      request: { messages: [{ type: 'text', text: 'changed broadcast' }] },
    })).resolves.toBe('sent');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls[0]?.[0]).toEqual(params.request);
    expect(sqlite.prepare(
      `SELECT outcome, attempt_count FROM outbound_line_deliveries`,
    ).get()).toEqual({ outcome: 'accepted', attempt_count: 2 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get())
      .toEqual({ count: 0 });
  });

  it('preserves the broadcast projection when settling a tracked push', async () => {
    sqlite.exec(`
      INSERT INTO broadcasts
        (id, title, message_type, message_content, target_type, status, line_account_id)
        VALUES ('broadcast-a', 'A', 'text', 'hello', 'tag', 'sending', 'account-a');
    `);

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: '22222222-2222-5222-8222-222222222222',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'hello',
      source: 'broadcast',
      broadcastId: 'broadcast-a',
      request: { to: 'U-a', messages: [{ type: 'text', text: 'hello' }] },
      send: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe('sent');

    expect(sqlite.prepare(`SELECT broadcast_id FROM messages_log`).get())
      .toEqual({ broadcast_id: 'broadcast-a' });
  });

  it('keeps the first test-send log classification after a settlement retry', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const first = {
      operationId: '33333333-3333-5333-8333-333333333333',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'test draft',
      source: 'broadcast',
      logDeliveryType: 'test' as const,
      request: { to: 'U-a', messages: [{ type: 'text' as const, text: 'test draft' }] },
      send,
    };

    await expect(deliverTrackedLinePush({
      ...first,
      db: d1From(sqlite, 2),
      now: new Date('2026-08-30T00:00:00.000Z'),
    })).rejects.toThrow('OUTBOUND_LINE_SETTLEMENT_FAILED');

    const { logDeliveryType: _ignored, ...retry } = first;
    await expect(deliverTrackedLinePush({
      ...retry,
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:16:00.000Z'),
      content: 'changed draft',
      source: 'automation',
      request: { to: 'U-changed', messages: [{ type: 'text', text: 'changed draft' }] },
    })).resolves.toBe('sent');

    expect(sqlite.prepare(`SELECT delivery_type, source, content FROM messages_log`).get())
      .toEqual({ delivery_type: 'test', source: 'broadcast', content: 'test draft' });
  });

  it('reconciles an attempted test send from its frozen ledger after the broadcast is deleted', async () => {
    sqlite.exec(`
      INSERT INTO broadcasts
        (id, title, message_type, message_content, target_type, status, line_account_id)
        VALUES ('broadcast-test', 'A', 'text', 'draft', 'all', 'draft', 'account-a');
    `);
    const send = vi.fn().mockResolvedValue(undefined);
    const request = { to: 'U-a', messages: [{ type: 'text' as const, text: 'frozen test' }] };
    const operationId = '34343434-3434-5434-8434-343434343434';

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite, 2),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      broadcastId: 'broadcast-test',
      messageType: 'text',
      content: 'frozen test',
      source: 'broadcast',
      logDeliveryType: 'test',
      request,
      send,
    })).rejects.toThrow('OUTBOUND_LINE_SETTLEMENT_FAILED');
    sqlite.prepare(`DELETE FROM broadcasts WHERE id = 'broadcast-test'`).run();

    await expect(reconcileAttemptedBroadcastTestPushes({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:16:00.000Z'),
      resolveSender: async (scope) => {
        expect(scope).toEqual({ tenantId: 'tenant-a', lineAccountId: 'account-a' });
        return send;
      },
    })).resolves.toEqual({ accepted: 1, pending: 0, retired: 0 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls[1]?.[0]).toEqual(request);
    expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', attempt_count: 2 });
    expect(sqlite.prepare(`SELECT delivery_type, content, broadcast_id FROM messages_log`).all())
      .toEqual([{ delivery_type: 'test', content: 'frozen test', broadcast_id: null }]);
  });

  it('never replays a test-send operation that did not reach the attempt marker', async () => {
    const send = vi.fn();
    await expect(deliverTrackedLinePush({
      db: d1From(sqlite, undefined, 'SET attempt_count = attempt_count + 1'),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: '35353535-3535-5535-8535-353535353535',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'not attempted',
      source: 'broadcast',
      logDeliveryType: 'test',
      request: { to: 'U-a', messages: [{ type: 'text', text: 'not attempted' }] },
      send,
    })).rejects.toThrow('synthetic D1 run failure');

    const resolveSender = vi.fn();
    await expect(reconcileAttemptedBroadcastTestPushes({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:16:00.000Z'),
      resolveSender,
    })).resolves.toEqual({ accepted: 0, pending: 0, retired: 0 });

    expect(resolveSender).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'open', attempt_count: 0 });
  });

  it('retires an attempted broadcast operation whose frozen payload is missing', async () => {
    const now = new Date('2026-08-30T00:16:00.000Z');
    const operationId = '36363636-3636-5636-8636-363636363636';
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at, attempted_at,
       created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'broadcast', 'push', 'open', ?,
              'prepare-missing', 1, ?, ?, ?, ?, ?)`).run(
      operationId,
      operationId,
      new Date(now.getTime() + 3600_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );

    const resolveSender = vi.fn();
    await expect(reconcileAttemptedBroadcastTestPushes({
      db: d1From(sqlite),
      now,
      resolveSender,
    })).resolves.toEqual({ accepted: 0, pending: 0, retired: 1 });

    expect(resolveSender).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'payload_unavailable' });
  });

  it('registers attempted test-send reconciliation in the minute cron', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf8');

    expect(source).toContain('reconcileAttemptedBroadcastTestPushes({');
    expect(source).toContain("kind: 'channel_access_token'");
    expect(source).toContain('client.pushMessage(request.to, request.messages, retryKey)');
  });

  it('does not accept an operation when an unrelated log occupies its primary key', async () => {
    const operationId = '44444444-4444-5444-8444-444444444444';
    sqlite.prepare(`INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, line_account_id, created_at)
      VALUES (?, 'friend-a', 'incoming', 'text', 'existing', 'account-a', ?)`).run(
      operationId,
      '2026-08-30T00:00:00.000Z',
    );

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'outgoing',
      source: 'broadcast',
      logDeliveryType: 'test',
      request: { to: 'U-a', messages: [{ type: 'text', text: 'outgoing' }] },
      send: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('OUTBOUND_LINE_SETTLEMENT_FAILED');

    expect(sqlite.prepare(`SELECT outcome FROM outbound_line_deliveries WHERE id = ?`).get(operationId))
      .toEqual({ outcome: 'open' });
    expect(sqlite.prepare(`SELECT outbound_operation_id FROM messages_log WHERE id = ?`).get(operationId))
      .toEqual({ outbound_operation_id: null });
  });

  it('never retries a reply after LINE accepted it but settlement failed', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const firstNow = new Date('2026-08-30T00:00:00.000Z');
    const params = {
      operationId: '55555555-5555-5555-8555-555555555555',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite, 2),
      now: firstNow,
      ...params,
    })).rejects.toThrow('OUTBOUND_LINE_SETTLEMENT_FAILED');
    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(firstNow.getTime() + 15_001),
      ...params,
    })).resolves.toBe('reconciliation_required');

    expect(send).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(`SELECT outcome, delivery_type, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'open', delivery_type: 'reply', stop_reason: null });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get())
      .toEqual({ count: 0 });
  });

  it('recovers an inline prepare read response loss before the provider attempt', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const params = {
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: '56565656-5656-5656-8565-565656565656',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite, undefined, undefined, undefined, 'SELECT outcome, source'),
      ...params,
    })).resolves.toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', attempt_count: 1 });
  });

  it('recovers an inline prepare batch response loss before the provider attempt', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const params = {
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: '56565656-5656-5656-8565-565656565657',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite, undefined, undefined, undefined, undefined, undefined, 1),
      ...params,
    })).resolves.toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT outcome, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', attempt_count: 1 });
  });

  it('recovers a known-unsent reply when the attempt marker response is lost', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const now = new Date('2026-08-30T00:00:00.000Z');
    const params = {
      operationId: '57575757-5757-5757-8575-575757575757',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(
        sqlite,
        undefined,
        undefined,
        undefined,
        undefined,
        'SET attempt_count = attempt_count + 1',
      ),
      now,
      ...params,
    })).resolves.toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', stop_reason: null, attempt_count: 1 });

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(now.getTime() + 30_001),
      ...params,
    })).resolves.toBe('already_sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('leaves an uncertain marker response open when its state cannot be read back', async () => {
    const send = vi.fn();
    const now = new Date('2026-08-30T00:00:00.000Z');
    const params = {
      operationId: '57575757-5757-5757-8575-575757575759',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(
        sqlite,
        undefined,
        undefined,
        undefined,
        undefined,
        'SET attempt_count = attempt_count + 1',
        undefined,
        'SELECT outcome, attempt_count, prepare_token',
      ),
      now,
      ...params,
    })).rejects.toThrow('synthetic D1 response loss after commit');
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'open', stop_reason: null, attempt_count: 1 });

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(now.getTime() + 15_001),
      ...params,
    })).resolves.toBe('reconciliation_required');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a crash after the reply marker in operator reconciliation without replaying LINE', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const operationId = '57575757-5757-5757-8575-575757575758';
    const retryUntil = new Date(now.getTime() + 65_000).toISOString();
    sqlite.exec(`
      INSERT INTO scenarios
        (id, name, trigger_type, delivery_mode, tenant_id, line_account_id, is_active)
        VALUES ('scenario-crash', 'Crash boundary', 'friend_add', 'relative',
                'tenant-a', 'account-a', 1);
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content)
        VALUES ('step-crash', 'scenario-crash', 1, 0, 'text', 'reply');
      INSERT INTO friend_scenarios
        (id, friend_id, scenario_id, current_step_order, status, started_at,
         next_delivery_at, updated_at, delivery_first_attempted_at, delivery_claim_token)
        VALUES ('enrollment-crash', 'friend-a', 'scenario-crash', 0, 'paused',
                '2026-08-30T09:00:00.000+09:00', NULL,
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                'claim-crash');
    `);
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at, attempted_at,
       created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'scenario', 'reply', 'open', NULL,
              'prepare-crash', 1, ?, ?, ?, ?, ?)`).run(
      operationId,
      retryUntil,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    sqlite.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id, message_type, log_content,
       log_delivery_type, scenario_enrollment_id, scenario_step_id, scenario_claim_token,
       created_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'text', 'reply', 'reply',
              'enrollment-crash', 'step-crash', 'claim-crash', ?)`).run(
      operationId,
      now.toISOString(),
    );
    const send = vi.fn();
    const params = {
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      scenarioEnrollmentId: 'enrollment-crash',
      scenarioStepId: 'step-crash',
      scenarioClaimToken: 'claim-crash',
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(now.getTime() + 15_001),
      ...params,
    })).resolves.toBe('reconciliation_required');
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'open', stop_reason: null });

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(now.getTime() + 65_001),
      ...params,
    })).resolves.toBe('reconciliation_required');
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'retry_window_expired' });
    await expect(reconcileUnsentScenarioReplies(d1From(sqlite))).resolves.toBe(0);
    expect(sqlite.prepare(`SELECT status FROM friend_scenarios WHERE id = 'enrollment-crash'`).get())
      .toEqual({ status: 'paused' });
  });

  it('does not call LINE after an unattempted reply passes the reply-token window', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const now = new Date('2026-08-30T00:00:00.000Z');
    const params = {
      operationId: '58585858-5858-5858-8585-585858585858',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    const retryUntil = new Date(now.getTime() + 65_000).toISOString();
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, prepare_token,
       attempt_count, retry_until, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'auto_reply', 'reply', 'open', 'prepare-orphan',
              0, ?, ?, ?)`).run(
      params.operationId,
      retryUntil,
      now.toISOString(),
      now.toISOString(),
    );
    sqlite.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id, message_type, log_content,
       log_delivery_type, created_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'text', 'reply', 'reply', ?)`)
      .run(params.operationId, now.toISOString());

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(now.getTime() + 65_001),
      ...params,
    })).resolves.toBe('not_sent');
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'retry_window_expired', attempt_count: 0 });
  });

  it('does not reclaim a reply while the first provider call is still running', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    let releaseFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    const send = vi.fn()
      .mockImplementationOnce(() => firstSend)
      .mockResolvedValue(undefined);
    const params = {
      operationId: '59595959-5959-5959-8595-595959595959',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    } as const;

    const firstDelivery = deliverTrackedLineReply({
      db: d1From(sqlite),
      now,
      ...params,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    const secondResult = await deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date(now.getTime() + 15_001),
      ...params,
    });
    releaseFirstSend();
    await firstDelivery;

    expect(secondResult).toBe('reconciliation_required');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not call LINE when beforeSend crosses the reply deadline', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const send = vi.fn();

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now,
      operationId: '59595959-5959-5959-8595-595959595958',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      beforeSend: async () => {
        now.setTime(now.getTime() + 65_001);
        return true;
      },
      send,
    })).resolves.toBe('not_sent');

    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'retry_window_expired', attempt_count: 0 });
  });

  it('does not call LINE when the attempt marker crosses the reply deadline', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const send = vi.fn();
    const db = d1From(sqlite, undefined, undefined, (sql) => {
      if (sql.includes('SET attempt_count = attempt_count + 1')) {
        now.setTime(now.getTime() + 65_001);
      }
    });

    await expect(deliverTrackedLineReply({
      db,
      now,
      operationId: '59595959-5959-5959-8595-595959595957',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      send,
    })).resolves.toBe('reconciliation_required');

    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'retry_window_expired', attempt_count: 1 });
  });

  it('settles a tracked reply and its message log together', async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: '66666666-6666-5666-8666-666666666666',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'auto_reply',
      send,
    })).resolves.toBe('sent');

    expect(send).toHaveBeenCalledOnce();
    expect(sqlite.prepare(`SELECT outcome, delivery_type FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', delivery_type: 'reply' });
    expect(sqlite.prepare(`SELECT delivery_type FROM messages_log`).get())
      .toEqual({ delivery_type: 'reply' });
  });

  it('terminalizes a paused scenario reply when attempt persistence fails before LINE', async () => {
    sqlite.exec(`
      INSERT INTO scenarios
        (id, name, trigger_type, delivery_mode, tenant_id, line_account_id, is_active)
        VALUES ('scenario-a', 'Scenario A', 'friend_add', 'relative',
                'tenant-a', 'account-a', 1);
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content)
        VALUES
          ('step-a-0', 'scenario-a', 1, 0, 'text', 'welcome'),
          ('step-a-1', 'scenario-a', 2, 60, 'text', 'next');
      INSERT INTO friend_scenarios
        (id, friend_id, scenario_id, current_step_order, status, started_at,
         next_delivery_at, updated_at, delivery_first_attempted_at, delivery_claim_token)
        VALUES ('enrollment-a', 'friend-a', 'scenario-a', 0, 'delivering',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                'claim-a');
    `);
    const operationId = 'dddddddd-dddd-5ddd-8ddd-dddddddddddd';
    const now = new Date('2026-08-30T00:00:00.000Z');
    const send = vi.fn().mockResolvedValue(undefined);
    const params = {
      now,
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'welcome',
      source: 'scenario',
      scenarioEnrollmentId: 'enrollment-a',
      scenarioStepId: 'step-a-0',
      scenarioClaimToken: 'claim-a',
      beforeSend: async () => {
        sqlite.prepare(`UPDATE friend_scenarios SET status = 'paused'
          WHERE id = 'enrollment-a' AND status = 'delivering'`).run();
        return true;
      },
      send,
    } as const;

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite, undefined, 'SET attempt_count = attempt_count + 1'),
      ...params,
    })).rejects.toThrow('synthetic D1 run failure');

    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT status FROM friend_scenarios WHERE id = 'enrollment-a'`).get())
      .toEqual({ status: 'paused' });
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count
      FROM outbound_line_deliveries`).get()).toEqual({
      outcome: 'retired', stop_reason: 'local_precondition_failed', attempt_count: 0,
    });
    await expect(reconcileUnsentScenarioReplies(d1From(sqlite))).resolves.toBe(1);
    expect(sqlite.prepare(`SELECT status FROM friend_scenarios WHERE id = 'enrollment-a'`).get())
      .toEqual({ status: 'active' });
    await expect(reconcileUnsentScenarioReplies(d1From(sqlite))).resolves.toBe(0);
  });

  it('records a local precondition failure without calling LINE', async () => {
    const send = vi.fn();

    await expect(deliverTrackedLineReply({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      beforeSend: async () => false,
      send,
    })).resolves.toBe('not_sent');

    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count
      FROM outbound_line_deliveries`).get()).toEqual({
      outcome: 'retired', stop_reason: 'local_precondition_failed', attempt_count: 0,
    });
  });

  it('resumes a deterministically rejected scenario reply but not an ambiguous one', async () => {
    sqlite.exec(`
      INSERT INTO scenarios
        (id, name, trigger_type, delivery_mode, tenant_id, line_account_id, is_active)
        VALUES ('scenario-a', 'Scenario A', 'friend_add', 'relative',
                'tenant-a', 'account-a', 1);
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content)
        VALUES ('step-a-0', 'scenario-a', 1, 0, 'text', 'welcome');
      INSERT INTO friend_scenarios
        (id, friend_id, scenario_id, current_step_order, status, started_at,
         next_delivery_at, updated_at, delivery_first_attempted_at, delivery_claim_token)
        VALUES ('enrollment-a', 'friend-a', 'scenario-a', 0, 'delivering',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                'claim-a');
    `);
    const now = new Date('2026-08-30T00:00:00.000Z');
    const db = d1From(sqlite);

    await expect(deliverTrackedLineReply({
      db,
      now,
      operationId: 'eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'welcome',
      source: 'scenario',
      scenarioEnrollmentId: 'enrollment-a',
      scenarioStepId: 'step-a-0',
      scenarioClaimToken: 'claim-a',
      beforeSend: async () => {
        sqlite.prepare(`UPDATE friend_scenarios SET status = 'paused'
          WHERE id = 'enrollment-a' AND status = 'delivering'`).run();
        return true;
      },
      isDeterministicRejection: () => true,
      send: async () => { throw new Error('Invalid reply token'); },
    })).resolves.toBe('not_sent');

    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count
      FROM outbound_line_deliveries`).get()).toEqual({
      outcome: 'retired', stop_reason: 'reply_rejected', attempt_count: 1,
    });
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, prepare_token,
       attempt_count, retry_until, first_attempted_at, attempted_at, settled_at, stop_reason,
       created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'scenario', 'reply', 'retired', 'ambiguous',
              1, ?, ?, ?, ?, 'reply_outcome_unknown', ?, ?)`).run(
      'ffffffff-ffff-5fff-8fff-ffffffffffff',
      now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(),
      now.toISOString(), now.toISOString(),
    );
    sqlite.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id, message_type, log_content,
       log_delivery_type, scenario_enrollment_id, scenario_step_id, scenario_claim_token, created_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'text', 'welcome', 'reply',
              'enrollment-a', 'step-a-0', 'claim-a', ?)`).run(
      'ffffffff-ffff-5fff-8fff-ffffffffffff', now.toISOString(),
    );

    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, prepare_token,
       attempt_count, retry_until, settled_at, stop_reason, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'scenario', 'reply', 'retired', 'ambiguous-zero',
              0, ?, ?, 'reply_outcome_unknown', ?, ?)`).run(
      'abababab-abab-5aba-8aba-abababababab',
      now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(),
    );
    sqlite.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id, message_type, log_content,
       log_delivery_type, scenario_enrollment_id, scenario_step_id, scenario_claim_token, created_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'text', 'welcome', 'reply',
              'enrollment-a', 'step-a-0', 'claim-a', ?)`).run(
      'abababab-abab-5aba-8aba-abababababab', now.toISOString(),
    );

    await expect(reconcileUnsentScenarioReplies(db)).resolves.toBe(0);
    sqlite.prepare(`DELETE FROM outbound_line_deliveries
      WHERE id = 'ffffffff-ffff-5fff-8fff-ffffffffffff'`).run();
    await expect(reconcileUnsentScenarioReplies(db)).resolves.toBe(0);
    sqlite.prepare(`DELETE FROM outbound_line_deliveries
      WHERE id = 'abababab-abab-5aba-8aba-abababababab'`).run();
    await expect(reconcileUnsentScenarioReplies(db)).resolves.toBe(1);
    expect(sqlite.prepare(`SELECT status FROM friend_scenarios WHERE id = 'enrollment-a'`).get())
      .toEqual({ status: 'active' });
  });

  it('reconciles an accepted scenario reply from its durable enrollment binding', async () => {
    sqlite.exec(`
      INSERT INTO scenarios
        (id, name, trigger_type, delivery_mode, tenant_id, line_account_id, is_active)
        VALUES ('scenario-a', 'Scenario A', 'friend_add', 'relative',
                'tenant-a', 'account-a', 1);
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content)
        VALUES
          ('step-a-0', 'scenario-a', 0, 0, 'text', 'welcome'),
          ('step-a-1', 'scenario-a', 1, 60, 'text', 'next');
      INSERT INTO friend_scenarios
        (id, friend_id, scenario_id, current_step_order, status, started_at,
         next_delivery_at, updated_at, delivery_first_attempted_at, delivery_claim_token)
        VALUES ('enrollment-a', 'friend-a', 'scenario-a', -1, 'active',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                '2026-08-30T09:00:00.000+09:00', NULL, NULL);
    `);
    const send = vi.fn().mockResolvedValue(undefined);
    const db = d1From(sqlite);
    const claimToken = await claimFriendScenarioForDelivery(db, 'enrollment-a', -1);
    expect(claimToken).toEqual(expect.any(String));
    await expect(markFriendScenarioDeliveryAttempt(
      db,
      'enrollment-a',
      claimToken as string,
    )).resolves.toBe(true);

    await expect(deliverTrackedLineReply({
      db,
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'welcome',
      source: 'scenario',
      scenarioEnrollmentId: 'enrollment-a',
      scenarioStepId: 'step-a-0',
      scenarioClaimToken: claimToken,
      templateIdAtSend: 'template-a',
      beforeSend: () => pauseFriendScenarioDelivery(
        db,
        'enrollment-a',
        claimToken as string,
      ),
      send,
    })).resolves.toBe('sent');

    expect(sqlite.prepare(`SELECT scenario_enrollment_id, scenario_step_id
      FROM outbound_line_delivery_payloads`).get()).toEqual({
      scenario_enrollment_id: 'enrollment-a', scenario_step_id: 'step-a-0',
    });
    expect(sqlite.prepare(`SELECT scenario_step_id, template_id_at_send FROM messages_log`).get())
      .toEqual({ scenario_step_id: 'step-a-0', template_id_at_send: 'template-a' });
    sqlite.prepare(`UPDATE friend_scenarios SET delivery_claim_token = 'claim-replacement'
      WHERE id = 'enrollment-a'`).run();
    await expect(reconcileAcceptedScenarioReplies(db)).resolves.toBe(0);
    expect(sqlite.prepare(`SELECT current_step_order, status FROM friend_scenarios
      WHERE id = 'enrollment-a'`).get()).toEqual({
      current_step_order: -1,
      status: 'paused',
    });
    sqlite.prepare(`UPDATE friend_scenarios SET delivery_claim_token = ?
      WHERE id = 'enrollment-a'`).run(claimToken);
    await expect(reconcileAcceptedScenarioReplies(db)).resolves.toBe(1);
    expect(sqlite.prepare(`SELECT current_step_order, status, next_delivery_at
      FROM friend_scenarios WHERE id = 'enrollment-a'`).get()).toMatchObject({
      current_step_order: 0,
      status: 'active',
      next_delivery_at: expect.any(String),
    });
    await expect(reconcileAcceptedScenarioReplies(db)).resolves.toBe(0);
  });

  it('reconciles an accepted reply for an account-bound scenario with a NULL tenant_id', async () => {
    sqlite.exec(`
      INSERT INTO scenarios
        (id, name, trigger_type, delivery_mode, tenant_id, line_account_id, is_active)
        VALUES ('scenario-account-bound', 'Account-bound', 'friend_add', 'relative',
                NULL, 'account-a', 1);
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content)
        VALUES ('step-account-bound', 'scenario-account-bound', 0, 0, 'text', 'welcome');
      INSERT INTO friend_scenarios
        (id, friend_id, scenario_id, current_step_order, status, started_at,
         next_delivery_at, updated_at)
        VALUES ('enrollment-account-bound', 'friend-a', 'scenario-account-bound', -1, 'active',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                '2026-08-30T09:00:00.000+09:00');
    `);
    const db = d1From(sqlite);
    const claimToken = await claimFriendScenarioForDelivery(db, 'enrollment-account-bound', -1);
    expect(claimToken).toEqual(expect.any(String));
    await expect(markFriendScenarioDeliveryAttempt(
      db,
      'enrollment-account-bound',
      claimToken as string,
    )).resolves.toBe(true);

    await expect(deliverTrackedLineReply({
      db,
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId: 'cacacaca-caca-5aca-8aca-cacacacacaca',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'welcome',
      source: 'scenario',
      scenarioEnrollmentId: 'enrollment-account-bound',
      scenarioStepId: 'step-account-bound',
      scenarioClaimToken: claimToken,
      beforeSend: () => pauseFriendScenarioDelivery(
        db,
        'enrollment-account-bound',
        claimToken as string,
      ),
      send: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBe('sent');

    await expect(reconcileAcceptedScenarioReplies(db)).resolves.toBe(1);
    expect(sqlite.prepare(`SELECT current_step_order, status, next_delivery_at
      FROM friend_scenarios WHERE id = 'enrollment-account-bound'`).get()).toEqual({
      current_step_order: -1,
      status: 'completed',
      next_delivery_at: null,
    });
  });

  it('replays a retired reply_rejected operation as not_sent', async () => {
    const db = d1From(sqlite);
    const operationId = 'cbcbcbcb-cbcb-5bcb-8bcb-cbcbcbcbcbcb';
    const send = vi.fn().mockRejectedValue(new Error('Invalid reply token'));
    const params = {
      db,
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      isDeterministicRejection: () => true,
      send,
    } as const;

    await expect(deliverTrackedLineReply(params)).resolves.toBe('not_sent');
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'reply_rejected' });

    await expect(deliverTrackedLineReply(params)).resolves.toBe('not_sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('replays a retired local_precondition_failed operation as not_sent', async () => {
    const db = d1From(sqlite);
    const operationId = 'cdcdcdcd-cdcd-5dcd-8dcd-cdcdcdcdcdcd';
    const send = vi.fn();
    const params = {
      db,
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      beforeSend: async () => false,
      send,
    } as const;

    await expect(deliverTrackedLineReply(params)).resolves.toBe('not_sent');
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'local_precondition_failed' });

    await expect(deliverTrackedLineReply(params)).resolves.toBe('not_sent');
    expect(send).not.toHaveBeenCalled();
  });

  it('requires reconciliation for a legacy attempted local_precondition failure', async () => {
    const db = d1From(sqlite);
    const operationId = 'cececece-cece-5ece-8ece-cececececece';
    const now = new Date('2026-08-30T00:00:00.000Z');
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at, attempted_at,
       settled_at, stop_reason, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'scenario', 'reply', 'retired', NULL,
              'prepare-legacy', 1, ?, ?, ?, ?, 'local_precondition_failed', ?, ?)`).run(
      operationId,
      new Date(now.getTime() + 65_000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    const send = vi.fn();

    await expect(deliverTrackedLineReply({
      db,
      now,
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'reply',
      source: 'scenario',
      send,
    })).resolves.toBe('reconciliation_required');
    expect(send).not.toHaveBeenCalled();
  });

  it('retires a stale open scenario reply when the claim token changes', async () => {
    sqlite.exec(`
      INSERT INTO scenarios
        (id, name, trigger_type, delivery_mode, tenant_id, line_account_id, is_active)
        VALUES ('scenario-stale', 'Stale scenario', 'friend_add', 'relative',
                'tenant-a', 'account-a', 1);
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content)
        VALUES ('step-stale', 'scenario-stale', 1, 0, 'text', 'welcome');
      INSERT INTO friend_scenarios
        (id, friend_id, scenario_id, current_step_order, status, started_at,
         next_delivery_at, updated_at, delivery_claim_token)
        VALUES ('enrollment-stale', 'friend-a', 'scenario-stale', 0, 'delivering',
                '2026-08-30T09:00:00.000+09:00', '2026-08-30T09:00:00.000+09:00',
                '2026-08-30T09:00:00.000+09:00', 'claim-old');
    `);
    const now = new Date('2026-08-30T00:00:00.000Z');
    const operationId = 'cececece-cece-5ece-8ece-cececececece';
    const retryUntil = new Date(now.getTime() + 3600_000).toISOString();
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, prepare_token,
       attempt_count, retry_until, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'scenario', 'reply', 'open', 'prepare-old',
              0, ?, ?, ?)`).run(operationId, retryUntil, now.toISOString(), now.toISOString());
    sqlite.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id, message_type, log_content,
       log_delivery_type, scenario_enrollment_id, scenario_step_id, scenario_claim_token, created_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'text', 'welcome', 'reply',
              'enrollment-stale', 'step-stale', 'claim-old', ?)`).run(
      operationId,
      now.toISOString(),
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const params = {
      db: d1From(sqlite),
      now,
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'welcome',
      source: 'scenario',
      scenarioEnrollmentId: 'enrollment-stale',
      scenarioStepId: 'step-stale',
      send,
    } as const;

    await expect(deliverTrackedLineReply({ ...params, scenarioClaimToken: 'claim-old' }))
      .resolves.toBe('in_flight');
    expect(send).not.toHaveBeenCalled();

    sqlite.prepare(`UPDATE friend_scenarios SET delivery_claim_token = 'claim-replacement'
      WHERE id = 'enrollment-stale'`).run();
    await expect(deliverTrackedLineReply({
      ...params,
      now: new Date(now.getTime() + 15_001),
      scenarioClaimToken: 'claim-replacement',
    }))
      .resolves.toBe('not_sent');
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason, attempt_count
      FROM outbound_line_deliveries`).get()).toEqual({
      outcome: 'retired', stop_reason: 'local_precondition_failed', attempt_count: 0,
    });
  });

  it('retires an unknown operation after the 24-hour provider horizon', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const old = new Date(now.getTime() - 25 * 3600_000).toISOString();
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at, attempted_at,
       created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'automation', 'push', 'open', ?,
              'prepare-old', 1, ?, ?, ?, ?, ?)`).run(
      '22222222-2222-5222-8222-222222222222',
      '22222222-2222-5222-8222-222222222222',
      old, old, old, old, old,
    );
    sqlite.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id,
       message_type, log_content, log_delivery_type, request_json, created_at)
      VALUES (?, 'tenant-a', 'account-a', 'friend-a', 'text', 'hello', 'push', ?, ?)`).run(
      '22222222-2222-5222-8222-222222222222',
      JSON.stringify({ to: 'U-a', messages: [{ type: 'text', text: 'hello' }] }),
      old,
    );
    const send = vi.fn();

    const result = await deliverTrackedLinePush({
      db: d1From(sqlite),
      now,
      operationId: '22222222-2222-5222-8222-222222222222',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'hello',
      source: 'automation',
      request: { to: 'U-a', messages: [{ type: 'text', text: 'hello' }] },
      send,
    });

    expect(result).toBe('reconciliation_required');
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'retry_window_expired' });
  });

  it('retires stale unknown rows for count-only reconciliation', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const insert = sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at, attempted_at,
       created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'automation', 'push', 'open', ?, ?,
              1, ?, ?, ?, ?, ?)`);
    const old = new Date(now.getTime() - 25 * 3600_000).toISOString();
    const fresh = new Date(now.getTime() - 23 * 3600_000).toISOString();
    const freshRetryUntil = new Date(now.getTime() + 3600_000).toISOString();
    insert.run('33333333-3333-5333-8333-333333333333',
      '33333333-3333-5333-8333-333333333333', 'prepare-old', old, old, old, old, old);
    insert.run('44444444-4444-5444-8444-444444444444',
      '44444444-4444-5444-8444-444444444444', 'prepare-fresh',
      freshRetryUntil, fresh, fresh, fresh, fresh);

    await expect(retireExpiredOutboundLineDeliveries(d1From(sqlite), now)).resolves.toBe(1);
    expect(sqlite.prepare(`SELECT id, outcome FROM outbound_line_deliveries ORDER BY id`).all())
      .toEqual([
        { id: '33333333-3333-5333-8333-333333333333', outcome: 'retired' },
        { id: '44444444-4444-5444-8444-444444444444', outcome: 'open' },
      ]);
  });

  it('retires an operation with a missing payload instead of rebuilding it', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const retryUntil = new Date(now.getTime() + 3600_000).toISOString();
    sqlite.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'automation', 'push', 'open', ?,
              'prepare-missing', 0, ?, ?, ?)`).run(
      '77777777-7777-5777-8777-777777777777',
      '77777777-7777-5777-8777-777777777777',
      retryUntil,
      now.toISOString(),
      now.toISOString(),
    );
    const send = vi.fn();

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite),
      now,
      operationId: '77777777-7777-5777-8777-777777777777',
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'changed content',
      source: 'automation',
      request: { to: 'U-changed', messages: [{ type: 'text', text: 'changed' }] },
      send,
    })).resolves.toBe('reconciliation_required');

    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'payload_unavailable' });
  });

  it('does not call LINE after the reaper retires a prepared push', async () => {
    const operationId = '87878787-8787-5787-8787-878787878787';
    let retired = false;
    const db = d1From(sqlite, undefined, undefined, (sql) => {
      if (retired || !sql.includes('SET attempt_count = attempt_count + 1')) return;
      retired = true;
      sqlite.prepare(`UPDATE outbound_line_deliveries
        SET outcome = 'retired', settled_at = ?, stop_reason = 'retry_window_expired'
        WHERE id = ?`).run('2026-08-30T00:00:00.000Z', operationId);
    });
    const send = vi.fn();

    await expect(deliverTrackedLinePush({
      db,
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'hello',
      source: 'automation',
      request: { to: 'U-a', messages: [{ type: 'text', text: 'hello' }] },
      send,
    })).resolves.toBe('reconciliation_required');

    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'retired', stop_reason: 'retry_window_expired' });
  });

  it('records a late provider acceptance after the operation was retired', async () => {
    const operationId = '88888888-8888-5888-8888-888888888888';
    const send = vi.fn(async () => {
      sqlite.prepare(`UPDATE outbound_line_deliveries
        SET outcome = 'retired', settled_at = ?, stop_reason = 'retry_window_expired'
        WHERE id = ?`).run('2026-08-30T00:00:01.000Z', operationId);
    });

    await expect(deliverTrackedLinePush({
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'hello',
      source: 'automation',
      request: { to: 'U-a', messages: [{ type: 'text', text: 'hello' }] },
      send,
    })).resolves.toBe('sent');

    expect(sqlite.prepare(`SELECT outcome, stop_reason FROM outbound_line_deliveries`).get())
      .toEqual({ outcome: 'accepted', stop_reason: null });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get())
      .toEqual({ count: 1 });
  });

  it('uses the first stored request for concurrent callers sharing an operation', async () => {
    const operationId = '99999999-9999-5999-8999-999999999999';
    const send = vi.fn().mockResolvedValue(undefined);
    const base = {
      db: d1From(sqlite),
      now: new Date('2026-08-30T00:00:00.000Z'),
      operationId,
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      messageType: 'text',
      content: 'first',
      source: 'automation',
      send,
    } as const;
    const firstRequest = { to: 'U-a', messages: [{ type: 'text' as const, text: 'first' }] };

    await Promise.all([
      deliverTrackedLinePush({ ...base, request: firstRequest }),
      deliverTrackedLinePush({
        ...base,
        content: 'second',
        request: { to: 'U-changed', messages: [{ type: 'text', text: 'second' }] },
      }),
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([request]) => request)).toEqual([firstRequest, firstRequest]);
    expect(new Set(send.mock.calls.map(([, retryKey]) => retryKey)).size).toBe(1);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get())
      .toEqual({ count: 1 });
  });
});
