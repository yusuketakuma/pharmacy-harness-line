import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', '007_custom_064_legacy_access_grant_drain.sql');

describe('007 custom_064 legacy access grant drain', () => {
  it('revokes unbound legacy grants and rejects new unbound grants', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE platform_admin_access_grants (
        id TEXT PRIMARY KEY,
        session_token_hash TEXT,
        revoked_at TEXT,
        revoked_by TEXT
      );
      INSERT INTO platform_admin_access_grants VALUES
        ('legacy-active', NULL, NULL, NULL),
        ('legacy-revoked', NULL, '2026-08-29T00:00:00.000Z', 'platform-a'),
        ('bound-active', '${'a'.repeat(64)}', NULL, NULL);
    `);

    db.exec(readFileSync(MIGRATION, 'utf8'));

    expect(db.prepare(
      `SELECT revoked_at, revoked_by FROM platform_admin_access_grants WHERE id = 'legacy-active'`,
    ).get()).toMatchObject({
      revoked_at: expect.any(String),
      revoked_by: 'system:v033_session_binding_required',
    });
    expect(db.prepare(
      `SELECT revoked_at, revoked_by FROM platform_admin_access_grants WHERE id = 'legacy-revoked'`,
    ).get()).toEqual({ revoked_at: '2026-08-29T00:00:00.000Z', revoked_by: 'platform-a' });
    expect(db.prepare(
      `SELECT revoked_at FROM platform_admin_access_grants WHERE id = 'bound-active'`,
    ).get()).toEqual({ revoked_at: null });
    expect(() => db.prepare(
      `INSERT INTO platform_admin_access_grants (id, session_token_hash)
       VALUES ('new-unbound', NULL)`,
    ).run()).toThrow(/session binding required/i);
    expect(() => db.prepare(
      `UPDATE platform_admin_access_grants SET session_token_hash = NULL
        WHERE id = 'bound-active'`,
    ).run()).toThrow(/session binding immutable/i);
    expect(() => db.prepare(
      `UPDATE platform_admin_access_grants SET revoked_at = NULL
        WHERE id = 'legacy-revoked'`,
    ).run()).toThrow(/session binding required/i);
  });
});
