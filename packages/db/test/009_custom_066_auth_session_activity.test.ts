import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', '009_custom_066_auth_session_activity.sql');

describe('009 custom_066 auth session activity', () => {
  it('adds optional activity timestamps without invalidating existing sessions', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tenant_admin_sessions (token_hash TEXT PRIMARY KEY);
      CREATE TABLE platform_admin_sessions (token_hash TEXT PRIMARY KEY);
      INSERT INTO tenant_admin_sessions VALUES ('${'a'.repeat(64)}');
      INSERT INTO platform_admin_sessions VALUES ('${'b'.repeat(64)}');
    `);

    db.exec(readFileSync(MIGRATION, 'utf8'));

    expect(db.prepare('SELECT last_seen_at FROM tenant_admin_sessions').get())
      .toEqual({ last_seen_at: null });
    expect(db.prepare('SELECT last_seen_at FROM platform_admin_sessions').get())
      .toEqual({ last_seen_at: null });
    expect(() => db.prepare(
      `UPDATE tenant_admin_sessions SET last_seen_at = 'not-a-date'`,
    ).run()).toThrow();
  });
});
