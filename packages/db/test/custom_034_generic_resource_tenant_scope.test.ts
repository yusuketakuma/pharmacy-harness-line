import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTag, getTags, updateTagMileageSettings } from '../src/tags.js';
import {
  createIncomingWebhook,
  getIncomingWebhookById,
  getIncomingWebhooks,
  updateIncomingWebhook,
} from '../src/webhooks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function d1From(sqlite: Database.Database): D1Database {
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({ success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {} }) as D1Result<T>,
    raw: async <T>() => sqlite.prepare(sql).raw().all(...values) as T[],
    run: async () => {
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
  }) as unknown as D1PreparedStatement;
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

describe('tenant-scoped generic resources', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    const now = '2026-08-19T00:00:00.000Z';
    sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)`)
      .run('tenant-a', 'a', 'A', now, now);
    sqlite.prepare(`INSERT INTO tenants (id, tenant_code, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)`)
      .run('tenant-b', 'b', 'B', now, now);
    db = d1From(sqlite);
  });

  it('lists and mutates tags only inside the authenticated tenant', async () => {
    const own = await createTag(db, { name: 'own', tenantId: 'tenant-a' });
    await createTag(db, { name: 'other', tenantId: 'tenant-b' });

    expect((await getTags(db, 'tenant-a')).map((tag) => tag.name)).toEqual(['own']);
    await expect(updateTagMileageSettings(db, own.id, {
      rewardMiles: 10,
      referralRewardMiles: 0,
      multiplierBps: null,
      multiplierPriority: 0,
    }, 'tenant-b')).resolves.toBeNull();
  });

  it('lists and mutates webhook settings only inside the authenticated tenant', async () => {
    const own = await createIncomingWebhook(db, {
      name: 'own', secret: 'a'.repeat(32), tenantId: 'tenant-a',
    });
    await createIncomingWebhook(db, {
      name: 'other', secret: 'b'.repeat(32), tenantId: 'tenant-b',
    });

    expect((await getIncomingWebhooks(db, 'tenant-a')).map((row) => row.name)).toEqual(['own']);
    await updateIncomingWebhook(db, own.id, { name: 'stolen' }, 'tenant-b');
    expect((await getIncomingWebhookById(db, own.id, 'tenant-a'))?.name).toBe('own');
    expect(await getIncomingWebhookById(db, own.id, 'tenant-b')).toBeNull();
    // Public delivery lookup remains ID-based; its HMAC is the authority.
    expect((await getIncomingWebhookById(db, own.id))?.name).toBe('own');
  });
});
