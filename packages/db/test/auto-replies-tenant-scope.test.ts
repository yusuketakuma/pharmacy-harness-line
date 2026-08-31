import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAutoReply,
  deleteAutoReply,
  getAutoReplies,
  getAutoReplyById,
  updateAutoReply,
} from '../src/auto-replies.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      results: sqlite.prepare(sql).all(...values) as T[],
      success: true,
      meta: {},
    }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  } as unknown as D1PreparedStatement);
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function insertTenant(sqlite: Database.Database, id: string): void {
  const now = '2026-08-31T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO tenants
    (id, tenant_code, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(id, id, id, now, now);
}

function insertAccount(sqlite: Database.Database, id: string, tenantId: string): void {
  const now = '2026-08-31T00:00:00.000+09:00';
  sqlite.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
    id,
    `channel-${id}`,
    id,
    `token-${id}`,
    `secret-${id}`,
    now,
    now,
  );
  sqlite.prepare(`INSERT INTO tenant_line_accounts
    (tenant_id, line_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(tenantId, id, now, now);
}

function insertReply(sqlite: Database.Database, id: string, lineAccountId: string | null): void {
  sqlite.prepare(`INSERT INTO auto_replies
    (id, keyword, match_type, response_type, response_content, line_account_id, is_active, created_at)
    VALUES (?, ?, 'exact', 'text', 'response', ?, 1, ?)`).run(
    id,
    id,
    lineAccountId,
    '2026-08-31T00:00:00.000+09:00',
  );
}

describe('auto-reply tenant scope', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    insertTenant(sqlite, 'tenant-a');
    insertTenant(sqlite, 'tenant-b');
    insertAccount(sqlite, 'account-a', 'tenant-a');
    insertAccount(sqlite, 'account-b', 'tenant-b');
    insertReply(sqlite, 'reply-a', 'account-a');
    insertReply(sqlite, 'reply-b', 'account-b');
    insertReply(sqlite, 'reply-global', null);
    db = d1From(sqlite);
  });

  it('lists only active account-bound rows mapped to the server tenant', async () => {
    expect((await getAutoReplies(db, undefined, 'tenant-a')).map((row) => row.id))
      .toEqual(['reply-a']);
    expect(await getAutoReplies(db, 'account-b', 'tenant-a')).toEqual([]);
  });

  it('quarantines NULL/global and foreign detail rows in tenant context', async () => {
    expect(await getAutoReplyById(db, 'reply-b', 'tenant-a')).toBeNull();
    expect(await getAutoReplyById(db, 'reply-global', 'tenant-a')).toBeNull();
    expect(await getAutoReplyById(db, 'reply-a', 'tenant-a')).toMatchObject({
      id: 'reply-a',
      line_account_id: 'account-a',
    });
  });

  it('rejects foreign update/delete and preserves the row', async () => {
    await expect(updateAutoReply(db, 'reply-b', { keyword: 'hacked' }, 'tenant-a')).resolves.toBeNull();
    await expect(deleteAutoReply(db, 'reply-b', 'tenant-a')).resolves.toBe(false);
    await expect(updateAutoReply(db, 'reply-global', { keyword: 'hacked' }, 'tenant-a')).resolves.toBeNull();
    await expect(deleteAutoReply(db, 'reply-global', 'tenant-a')).resolves.toBe(false);
    expect(sqlite.prepare('SELECT keyword FROM auto_replies WHERE id = ?').get('reply-b'))
      .toEqual({ keyword: 'reply-b' });

    const updated = await updateAutoReply(db, 'reply-a', { keyword: 'updated', lineAccountId: 'account-b' }, 'tenant-a');
    expect(updated).toMatchObject({ id: 'reply-a', keyword: 'updated', line_account_id: 'account-a' });
  });

  it('requires a non-null mapped account for tenant create', async () => {
    await expect(createAutoReply(db, {
      keyword: 'foreign',
      responseContent: 'response',
      lineAccountId: 'account-b',
      tenantId: 'tenant-a',
    })).resolves.toBeNull();
    await expect(createAutoReply(db, {
      keyword: 'global',
      responseContent: 'response',
      lineAccountId: null,
      tenantId: 'tenant-a',
    })).resolves.toBeNull();

    const created = await createAutoReply(db, {
      keyword: 'owned',
      responseContent: 'response',
      lineAccountId: 'account-a',
      tenantId: 'tenant-a',
    });
    expect(created).toMatchObject({ keyword: 'owned', line_account_id: 'account-a' });
  });

  it('preserves the explicit legacy OSS behavior without tenant scope', async () => {
    expect((await getAutoReplies(db)).map((row) => row.id)).toEqual([
      'reply-a',
      'reply-b',
      'reply-global',
      'builtin-mileage-wallet-keyword',
    ]);
    expect(await getAutoReplyById(db, 'reply-global')).toMatchObject({ line_account_id: null });
  });
});
