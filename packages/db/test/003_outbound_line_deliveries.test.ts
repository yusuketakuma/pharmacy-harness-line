import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('003 outbound LINE deliveries', () => {
  it('fences account scope, provider retry keys, and terminal outcomes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    db.exec(`
      INSERT INTO tenants (id, tenant_code, display_name) VALUES
        ('tenant-a', 'a', 'A'), ('tenant-b', 'b', 'B');
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES
        ('account-a', 'channel-a', 'A', 'token-a', 'secret-a'),
        ('account-b', 'channel-b', 'B', 'token-b', 'secret-b');
      INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES
        ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
      INSERT INTO friends
        (id, line_user_id, provider_line_user_id, line_account_id, is_following) VALUES
        ('friend-a', 'legacy-a', 'U-a', 'account-a', 1),
        ('friend-b', 'legacy-b', 'U-b', 'account-b', 1);
    `);
    const now = '2026-08-30T00:00:00.000Z';
    const insertPush = db.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at,
       attempted_at, created_at, updated_at)
      VALUES (?, ?, ?, 'automation', 'push', 'open', ?, ?, 1, ?, ?, ?, ?, ?)`);

    insertPush.run('delivery-a', 'tenant-a', 'account-a', 'retry-a', 'prepare-a',
      now, now, now, now, now);
    expect(() => insertPush.run(
      'delivery-cross', 'tenant-a', 'account-b', 'retry-cross', 'prepare-cross',
      now, now, now, now, now,
    )).toThrow();
    expect(() => db.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       prepare_token, attempt_count, retry_until, first_attempted_at,
       attempted_at, created_at, updated_at)
      VALUES ('reply-a', 'tenant-a', 'account-a', 'auto_reply', 'reply',
              'open', 'must-be-null', 'prepare-r', 1, ?, ?, ?, ?, ?)`)
      .run(now, now, now, now, now)).toThrow();
    expect(() => db.prepare(`UPDATE outbound_line_deliveries
      SET outcome = 'accepted' WHERE id = 'delivery-a'`).run()).toThrow();
    const insertPayload = db.prepare(`INSERT INTO outbound_line_delivery_payloads
      (operation_id, tenant_id, line_account_id, friend_id,
       message_type, log_content, log_delivery_type, request_json, created_at)
      VALUES ('delivery-a', ?, ?, ?, 'text', 'hello', ?, ?, ?)`);
    const request = JSON.stringify({ to: 'U-a', messages: [{ type: 'text', text: 'hello' }] });
    expect(() => insertPayload.run(
      'tenant-a', 'account-a', 'friend-b', 'test', request, now,
    )).toThrow();
    expect(() => insertPayload.run(
      'tenant-b', 'account-b', 'friend-b', 'test', request, now,
    )).toThrow();
    expect(() => insertPayload.run(
      'tenant-a', 'account-a', 'friend-a', 'invalid', request, now,
    )).toThrow();
    expect(() => insertPayload.run(
      'tenant-a', 'account-a', 'friend-a', 'test', request, now,
    )).not.toThrow();
    expect(db.prepare(`SELECT log_delivery_type FROM outbound_line_delivery_payloads`).get())
      .toEqual({ log_delivery_type: 'test' });

    const insertBroadcast = db.prepare(`INSERT INTO outbound_line_deliveries
      (id, tenant_id, line_account_id, source, delivery_type, outcome, retry_key,
       request_json, prepare_token, attempt_count, retry_until, created_at, updated_at)
      VALUES (?, 'tenant-a', 'account-a', 'broadcast', 'broadcast', 'open', ?, ?, ?, 0, ?, ?, ?)`);
    expect(() => insertBroadcast.run(
      'broadcast-delivery', 'broadcast-retry',
      JSON.stringify({ messages: [{ type: 'text', text: 'hello' }] }),
      'prepare-broadcast', now, now, now,
    )).not.toThrow();
    expect(() => insertBroadcast.run(
      'broadcast-missing-payload', 'broadcast-retry-2', null,
      'prepare-broadcast-2', now, now, now,
    )).toThrow();
  });
});
