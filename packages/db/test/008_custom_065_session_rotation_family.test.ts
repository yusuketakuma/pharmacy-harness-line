import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', '008_custom_065_session_rotation_family.sql');

describe('008 custom_065 session rotation family', () => {
  it('adds a validated rotation-family hash to both admin session tables', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tenant_admin_sessions (token_hash TEXT PRIMARY KEY);
      CREATE TABLE platform_admin_sessions (token_hash TEXT PRIMARY KEY);
      INSERT INTO tenant_admin_sessions VALUES ('${'a'.repeat(64)}');
      INSERT INTO platform_admin_sessions VALUES ('${'b'.repeat(64)}');
    `);

    db.exec(readFileSync(MIGRATION, 'utf8'));

    expect(db.prepare(
      `SELECT session_family_hash FROM tenant_admin_sessions`,
    ).get()).toEqual({ session_family_hash: null });
    expect(db.prepare(
      `SELECT session_family_hash FROM platform_admin_sessions`,
    ).get()).toEqual({ session_family_hash: null });
    expect(() => db.prepare(
      `UPDATE tenant_admin_sessions SET session_family_hash = 'short'`,
    ).run()).toThrow();
    expect(() => db.prepare(
      `UPDATE platform_admin_sessions SET session_family_hash = ?`,
    ).run('A'.repeat(64))).toThrow();
  });
});
