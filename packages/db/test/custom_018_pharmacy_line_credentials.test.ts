import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function database(): Database.Database {
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
  `);
  return db;
}

describe('custom_018_pharmacy_line_credentials.sql', () => {
  it('creates only encrypted credential storage with the three allowed kinds', () => {
    const db = database();

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
    const insert = db.prepare(`INSERT INTO pharmacy_line_credentials
      (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
       key_version, revision, lookup_digest, created_at, updated_at)
      VALUES ('tenant-a', 'account-a', ?, 'AAAAAAAAAAAAAAAA', 'ciphertext', 1, 1, ?, '2026-08-18', '2026-08-18')`);

    expect(() => insert.run('channel_access_token', null)).toThrow(/CHECK constraint failed/i);
    expect(() => insert.run('channel_secret', 'a'.repeat(64))).toThrow(/CHECK constraint failed/i);
  });

  it('rejects missing and cross-tenant LINE account mappings through the composite FK', () => {
    const db = database();
    const insert = db.prepare(`INSERT INTO pharmacy_line_credentials
      (tenant_id, line_account_id, credential_kind, nonce, ciphertext,
       key_version, revision, lookup_digest, created_at, updated_at)
      VALUES (?, ?, 'channel_secret', 'AAAAAAAAAAAAAAAA', 'ciphertext', 1, 1, NULL, '2026-08-18', '2026-08-18')`);

    expect(() => insert.run('tenant-a', 'account-b')).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => insert.run('missing-tenant', 'account-a')).toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => insert.run('tenant-a', 'missing-account')).toThrow(/FOREIGN KEY constraint failed/i);
  });

});
