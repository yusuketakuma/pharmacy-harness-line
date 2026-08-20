import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/custom_018_pharmacy_line_credentials.sql');

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE tenant_line_accounts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, line_account_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
    );
    INSERT INTO tenants VALUES ('tenant-a'), ('tenant-b');
    INSERT INTO line_accounts VALUES ('account-a'), ('account-b');
    INSERT INTO tenant_line_accounts VALUES ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
  `);
  return db;
}

function migration(): string {
  return readFileSync(MIGRATION, 'utf8');
}

describe('custom_018_pharmacy_line_credentials.sql', () => {
  it('creates only encrypted credential storage with the three allowed kinds', () => {
    const db = database();
    db.exec(migration());

    const columns = db.prepare(`PRAGMA table_info(pharmacy_line_credentials)`).all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      'tenant_id', 'line_account_id', 'credential_kind', 'nonce', 'ciphertext',
      'key_version', 'revision', 'lookup_digest', 'created_at', 'updated_at',
    ]);
    expect(columns.map((column) => column.name)).not.toContain('credential');

    const insert = db.prepare(`INSERT INTO pharmacy_line_credentials
      (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
       key_version, revision, lookup_digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, '2026-08-18', '2026-08-18')`);
    for (const [kind, digest] of [
      ['channel_access_token', 'a'.repeat(64)],
      ['channel_secret', null],
      ['login_channel_secret', null],
    ] as const) {
      expect(() => insert.run(
        'tenant-a', 'account-a', kind, 'AAAAAAAAAAAAAAAA', 'ciphertext', digest,
      )).not.toThrow();
    }

    expect(() => insert.run(
      'tenant-a', 'account-a', 'unsupported', 'AAAAAAAAAAAAAAAA', 'ciphertext', null,
    )).toThrow(/CHECK constraint failed/i);
  });

  it('requires the access-token digest only for channel access tokens', () => {
    const db = database();
    db.exec(migration());
    const insert = db.prepare(`INSERT INTO pharmacy_line_credentials
      (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
       key_version, revision, lookup_digest, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, 'AAAAAAAAAAAAAAAA', 'ciphertext', 1, 1, ?, '2026-08-18', '2026-08-18')`);

    expect(() => insert.run('channel_access_token', null)).toThrow(/CHECK constraint failed/i);
    expect(() => insert.run('channel_secret', 'a'.repeat(64))).toThrow(/CHECK constraint failed/i);
  });

  it('rejects missing and cross-tenant LINE account mappings through the composite FK', () => {
    const db = database();
    db.exec(migration());
    const insert = db.prepare(`INSERT INTO pharmacy_line_credentials
      (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
       key_version, revision, lookup_digest, created_at, updated_at)
      VALUES (?, ?, 'channel_secret', 'AAAAAAAAAAAAAAAA', 'ciphertext', 1, 1, NULL, '2026-08-18', '2026-08-18')`);

    expect(() => insert.run('tenant-a', 'account-b')).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => insert.run('missing-tenant', 'account-a')).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => insert.run('tenant-a', 'missing-account')).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('is idempotent for migration retry', () => {
    const db = database();
    expect(() => db.exec(migration())).not.toThrow();
    expect(() => db.exec(migration())).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM sqlite_master WHERE type = 'table' AND name = 'pharmacy_line_credentials'`).get())
      .toEqual({ count: 1 });
  });
});
