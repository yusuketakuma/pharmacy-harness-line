import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  computeLineAccessTokenLookupDigest,
} from './line-credentials.js';
import {
  deleteLineCredential,
  findLineCredentialByAccessToken,
  LINE_CREDENTIAL_CONFLICT_ERROR,
  LINE_CREDENTIAL_STORE_ERROR,
  readLineCredential,
  writeLineCredential,
} from './line-credential-store.js';

const ROOT_SECRET = 'synthetic-root-secret-for-store-tests-v1';
const ACCESS_TOKEN_A = `token-a-${'a'.repeat(64)}`;
const ACCESS_TOKEN_B = `token-b-${'b'.repeat(64)}`;
const ACCESS_TOKEN_C = `token-c-${'c'.repeat(64)}`;
const CHANNEL_SECRET = 'a'.repeat(32);
const require = createRequire(import.meta.url);
const CREDENTIAL_MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/db/migrations/custom_018_pharmacy_line_credentials.sql',
);

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};

type SqliteDatabase = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => SqliteDatabase;

type CredentialRow = {
  tenant_id: string;
  line_account_id: string;
  credential_kind: string;
  nonce: string;
  ciphertext: string;
  key_version: number;
  revision: number;
  lookup_digest: string | null;
};

type Call = { sql: string; values: unknown[] };

function memoryDb(options: { mappingActive?: boolean; dbError?: string } = {}) {
  let mappingActive = options.mappingActive ?? true;
  let dbError = options.dbError ?? null;
  const rows: CredentialRow[] = [];
  const calls: Call[] = [];

  function failIfConfigured(): void {
    if (dbError) throw new Error(dbError);
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              failIfConfigured();
              calls.push({ sql, values });
              if (sql.includes('INSERT INTO pharmacy_line_credentials')) {
                const [tenantId, lineAccountId, kind, nonce, ciphertext, keyVersion, lookupDigest] = values;
                const expectedRevision = values[11] as number | null;
                if (!mappingActive ||
                    (expectedRevision !== null && expectedRevision !== 0 &&
                      !rows.some((row) => row.tenant_id === tenantId &&
                        row.line_account_id === lineAccountId && row.credential_kind === kind))) {
                  return null;
                }
                const existing = rows.find((row) => row.tenant_id === tenantId &&
                  row.line_account_id === lineAccountId && row.credential_kind === kind);
                if (existing) {
                  if (expectedRevision !== null && existing.revision !== expectedRevision) return null;
                  existing.nonce = String(nonce);
                  existing.ciphertext = String(ciphertext);
                  existing.key_version = Number(keyVersion);
                  existing.lookup_digest = lookupDigest as string | null;
                  existing.revision += 1;
                  return { revision: existing.revision } as T;
                }
                const created: CredentialRow = {
                  tenant_id: String(tenantId),
                  line_account_id: String(lineAccountId),
                  credential_kind: String(kind),
                  nonce: String(nonce),
                  ciphertext: String(ciphertext),
                  key_version: Number(keyVersion),
                  revision: 1,
                  lookup_digest: lookupDigest as string | null,
                };
                rows.push(created);
                return { revision: created.revision } as T;
              }
              if (sql.includes('DELETE FROM pharmacy_line_credentials')) {
                const index = rows.findIndex((candidate) => mappingActive &&
                  candidate.tenant_id === values[0] && candidate.line_account_id === values[1] &&
                  candidate.credential_kind === values[2]);
                if (index < 0) return null;
                const [deleted] = rows.splice(index, 1);
                return { tenant_id: deleted!.tenant_id } as T;
              }
              if (sql.includes('lookup_digest = ?')) {
                const row = rows.find((candidate) => mappingActive &&
                  candidate.lookup_digest === values[0]);
                return (row ?? null) as T;
              }
              const row = rows.find((candidate) => mappingActive &&
                candidate.tenant_id === values[0] && candidate.line_account_id === values[1] &&
                candidate.credential_kind === values[2]);
              return (row ?? null) as T;
            },
            async all<T>() {
              failIfConfigured();
              calls.push({ sql, values });
              if (sql.includes('lookup_digest = ?')) {
                return {
                  results: rows.filter((candidate) => mappingActive &&
                    candidate.lookup_digest === values[0]).slice(0, 2),
                } as D1Result<T>;
              }
              return { results: [] } as unknown as D1Result<T>;
            },
            async run() {
              failIfConfigured();
              calls.push({ sql, values });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return {
    db,
    calls,
    rows,
    setMappingActive(value: boolean) { mappingActive = value; },
    setDbError(value: string | null) { dbError = value; },
  };
}

function sqliteDb() {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL);
    CREATE TABLE tenant_line_accounts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, line_account_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
    );
  `);
  sqlite.exec(readFileSync(CREDENTIAL_MIGRATION, 'utf8'));
  sqlite.exec(`
    INSERT INTO tenants VALUES ('tenant-a', 'active'), ('tenant-b', 'active');
    INSERT INTO line_accounts VALUES ('account-a', 1), ('account-b', 1);
    INSERT INTO tenant_line_accounts VALUES ('tenant-a', 'account-a'), ('tenant-b', 'account-b');
  `);

  const statement = (sql: string, values: unknown[] = []) => ({
    bind(...next: unknown[]) {
      return statement(sql, next);
    },
    first: async <T>() => (sqlite.prepare(sql).get(...values) as T | undefined) ?? null,
    all: async <T>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...values) as T[],
      meta: {},
    }) as D1Result<T>,
    run: async () => ({
      success: true,
      meta: { changes: sqlite.prepare(sql).run(...values).changes },
      results: [],
    }) as unknown as D1Result,
  });
  return {
    db: { prepare: (sql: string) => statement(sql) } as unknown as D1Database,
    close: () => sqlite.close(),
  };
}

describe('tenant-scoped LINE credential store', () => {
  it('executes the write, read, lookup, and CAS SQL against SQLite', async () => {
    const fake = sqliteDb();
    try {
      const first = await writeLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
        kind: 'channel_access_token', credential: ACCESS_TOKEN_A,
      });
      await expect(writeLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
        kind: 'channel_access_token', credential: ACCESS_TOKEN_B,
        expectedRevision: first.revision,
      })).resolves.toEqual({ revision: 2 });
      await expect(writeLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
        kind: 'channel_access_token', credential: ACCESS_TOKEN_C,
        expectedRevision: first.revision,
      })).rejects.toThrow(LINE_CREDENTIAL_CONFLICT_ERROR);
      await expect(readLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
      })).resolves.toBe(ACCESS_TOKEN_B);
      await expect(findLineCredentialByAccessToken(fake.db, ROOT_SECRET, ACCESS_TOKEN_B))
        .resolves.toMatchObject({ tenantId: 'tenant-a', lineAccountId: 'account-a', revision: 2 });
    } finally {
      fake.close();
    }
  });

  it('encrypts writes, checks the active mapping in SQL, and reads by all three keys', async () => {
    const fake = memoryDb();
    const result = await writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      kind: 'channel_access_token',
      credential: ACCESS_TOKEN_A,
    });

    expect(result).toEqual({ revision: 1 });
    expect(fake.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      line_account_id: 'account-a',
      credential_kind: 'channel_access_token',
    });
    expect(fake.rows[0]).not.toHaveProperty('credential');
    expect(fake.rows[0]?.ciphertext).not.toContain(ACCESS_TOKEN_A);
    const write = fake.calls.find((call) => call.sql.includes('INSERT INTO pharmacy_line_credentials'))!;
    expect(write.sql).toContain('tenant_line_accounts');
    expect(write.sql).toContain("tenant.status = 'active'");
    expect(write.sql).toContain('account.is_active = 1');
    expect(write.values).not.toContain(ACCESS_TOKEN_A);

    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
    })).resolves.toBe(ACCESS_TOKEN_A);

    fake.setMappingActive(false);
    await expect(writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_secret', credential: CHANNEL_SECRET,
    })).rejects.toThrow(LINE_CREDENTIAL_CONFLICT_ERROR);
  });

  it('fails closed for missing, corrupt, wrong-tenant, and legacy plaintext data', async () => {
    const fake = memoryDb();
    await writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_secret', credential: CHANNEL_SECRET,
    });

    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-b', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBeNull();
    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'missing', kind: 'channel_secret',
    })).resolves.toBeNull();

    fake.rows[0]!.ciphertext = 'corrupt';
    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBeNull();
    expect(fake.calls.every((call) => !call.sql.includes('channel_access_token') &&
      !call.sql.includes('channel_secret FROM line_accounts'))).toBe(true);
  });

  it('looks up access tokens by keyed digest and only returns active mapped accounts', async () => {
    const fake = memoryDb();
    await writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_A,
    });
    const digest = await computeLineAccessTokenLookupDigest(ROOT_SECRET, ACCESS_TOKEN_A);
    const found = await findLineCredentialByAccessToken(fake.db, ROOT_SECRET, ACCESS_TOKEN_A);

    expect(found).toMatchObject({
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_A, revision: 1,
    });
    const lookup = fake.calls.find((call) => call.sql.includes('lookup_digest = ?'))!;
    expect(lookup.values).toEqual([digest]);
    expect(lookup.values).not.toContain(ACCESS_TOKEN_A);

    fake.setMappingActive(false);
    await expect(findLineCredentialByAccessToken(fake.db, ROOT_SECRET, ACCESS_TOKEN_A))
      .resolves.toBeNull();
  });

  it('fails closed when one access token matches more than one active account', async () => {
    const fake = memoryDb();
    await writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_A,
    });
    await writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-b', lineAccountId: 'account-b',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_A,
    });

    await expect(findLineCredentialByAccessToken(fake.db, ROOT_SECRET, ACCESS_TOKEN_A))
      .resolves.toBeNull();
    expect(fake.calls.find((call) => call.sql.includes('LIMIT 2'))).toBeTruthy();
  });

  it('uses revision CAS for rotation and preserves the current value after a stale write', async () => {
    const fake = memoryDb();
    await expect(writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_A,
    })).resolves.toEqual({ revision: 1 });
    await expect(writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_B, expectedRevision: 1,
    })).resolves.toEqual({ revision: 2 });

    await expect(writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_access_token', credential: ACCESS_TOKEN_C, expectedRevision: 1,
    })).rejects.toThrow(LINE_CREDENTIAL_CONFLICT_ERROR);
    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
    })).resolves.toBe(ACCESS_TOKEN_B);
    expect(fake.rows[0]?.revision).toBe(2);
  });

  it('deletes only the mapped tenant/account credential', async () => {
    const fake = memoryDb();
    await writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_secret', credential: CHANNEL_SECRET,
    });

    await expect(deleteLineCredential(fake.db, {
      tenantId: 'tenant-b', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBe(false);
    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBe(CHANNEL_SECRET);

    await expect(deleteLineCredential(fake.db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBe(true);
    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBeNull();
    const deletion = fake.calls.find((call) => call.sql.includes('DELETE FROM pharmacy_line_credentials'))!;
    expect(deletion.sql).toContain('tenant_line_accounts');
  });

  it('does not log or return credentials when the database fails', async () => {
    const fake = memoryDb({ dbError: 'database failed with token secret' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(writeLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a',
      kind: 'channel_secret', credential: CHANNEL_SECRET,
    })).rejects.toThrow(LINE_CREDENTIAL_STORE_ERROR);
    await expect(readLineCredential(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_secret',
    })).resolves.toBeNull();
    await expect(findLineCredentialByAccessToken(fake.db, ROOT_SECRET, ACCESS_TOKEN_A))
      .resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('distinguishes a credential delete failure from an absent row', async () => {
    const fake = memoryDb({ dbError: 'delete failed' });

    await expect(deleteLineCredential(fake.db, {
      tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'login_channel_secret',
    })).rejects.toThrow(LINE_CREDENTIAL_STORE_ERROR);
  });
});
