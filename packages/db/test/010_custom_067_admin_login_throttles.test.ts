import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  claimLoginAttempt,
  clearLoginThrottle,
} from '../../../apps/worker/src/custom/pharmacy/provisioning/auth-throttle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', '010_custom_067_admin_login_throttles.sql');

function d1From(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

describe('010 custom_067 admin login throttles', () => {
  it('creates constrained durable account throttle state', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync(MIGRATION, 'utf8'));

    const sql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_login_throttles'`,
    ).pluck().get() as string;
    expect(sql).toContain("realm IN ('tenant', 'platform_admin')");
    expect(sql).toContain('PRIMARY KEY (realm, authority_id, login_id_normalized)');
    expect(() => db.prepare(
      `INSERT INTO admin_login_throttles
         (realm, authority_id, login_id_normalized, failure_count,
          window_started_at, next_allowed_at, locked_until, updated_at)
       VALUES ('tenant', 'tenant-a', 'admin', 0, ?, ?, NULL, ?)`,
    ).run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z')).toThrow();
  });

  it('enforces approved backoff and a fixed lock without extending blocked attempts', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(MIGRATION, 'utf8'));
    const db = d1From(sqlite);
    const key = { realm: 'tenant' as const, authorityId: 'tenant-a', loginId: 'ＡＤＭＩＮ' };
    const at = (seconds: number) => new Date(1_788_259_200_000 + seconds * 1000);

    await expect(claimLoginAttempt(db, key, at(0))).resolves.toMatchObject({
      allowed: true, failureCount: 1,
    });
    await expect(claimLoginAttempt(db, { ...key, loginId: 'admin' }, at(0)))
      .resolves.toMatchObject({ allowed: true, failureCount: 2 });
    await expect(claimLoginAttempt(db, key, at(0))).resolves.toEqual({ allowed: false });
    await expect(claimLoginAttempt(db, key, at(1)))
      .resolves.toMatchObject({ allowed: true, failureCount: 3 });
    await expect(claimLoginAttempt(db, key, at(3)))
      .resolves.toMatchObject({ allowed: true, failureCount: 4 });
    const fifth = await claimLoginAttempt(db, key, at(7));
    expect(fifth).toMatchObject({ allowed: true, failureCount: 5 });
    expect(fifth.allowed && fifth.lockedUntil).toBe(at(907).toISOString());
    await expect(claimLoginAttempt(db, key, at(8))).resolves.toEqual({ allowed: false });
    await expect(claimLoginAttempt(db, key, at(906))).resolves.toEqual({ allowed: false });
    await expect(claimLoginAttempt(db, key, at(907)))
      .resolves.toMatchObject({ allowed: true, failureCount: 1, lockedUntil: null });

    await clearLoginThrottle(db, key);
    expect(sqlite.prepare('SELECT COUNT(*) FROM admin_login_throttles').pluck().get()).toBe(0);
  });
});
