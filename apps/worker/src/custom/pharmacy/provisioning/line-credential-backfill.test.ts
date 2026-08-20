import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type LineCredentialKind,
} from './line-credentials.js';
import {
  backfillLineCredentials,
  restoreLegacyLineCredentials,
  scrubLegacyLineCredentials,
} from './line-credential-backfill.js';
import { readLineCredential, writeLineCredential } from './line-credential-store.js';

const ROOT_SECRET = 'synthetic-root-secret-for-backfill-tests-v1';
const ACCESS_TOKEN = `token-a-${'a'.repeat(64)}`;
const OTHER_ACCESS_TOKEN = `token-b-${'b'.repeat(64)}`;
const CHANNEL_SECRET = 's'.repeat(32);
const LOGIN_CHANNEL_SECRET = 'l'.repeat(32);
const LEGACY_SENTINEL = 'encrypted:v1';

const require = createRequire(import.meta.url);
const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/db/migrations/custom_018_pharmacy_line_credentials.sql',
);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => SqliteDatabase;

type SqliteStatement = {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { changes: number };
};

type SqliteDatabase = {
  pragma(sql: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(callback: () => T): () => T;
  close(): void;
};

type DatabaseOptions = {
  failCredentialWriteAt?: number;
};

function d1From(sqlite: SqliteDatabase, options: DatabaseOptions = {}) {
  let credentialWriteCount = 0;
  let failBatch = false;
  const queries: Array<{ sql: string; values: unknown[] }> = [];

  const statement = (sql: string, values: unknown[] = []) => ({
    bind(...next: unknown[]) {
      return statement(sql, next);
    },
    first: async <T>() => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO pharmacy_line_credentials')) {
        credentialWriteCount += 1;
        if (options.failCredentialWriteAt === credentialWriteCount) {
          throw new Error('synthetic credential write interruption');
        }
      }
      return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null;
    },
    all: async <T>() => {
      queries.push({ sql, values });
      return {
        success: true,
        results: sqlite.prepare(sql).all(...values) as T[],
        meta: {},
      } as D1Result<T>;
    },
    runSync: () => {
      if (failBatch && sql.includes('UPDATE line_accounts')) {
        throw new Error('synthetic scrub interruption');
      }
      const info = sqlite.prepare(sql).run(...values);
      return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result;
    },
    run: async () => statement(sql, values).runSync(),
  });

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async <T>(statements: Array<D1PreparedStatement>) => {
      if (failBatch) throw new Error('synthetic scrub interruption');
      return sqlite.transaction(() => statements.map((item) => (
        item as D1PreparedStatement & { runSync(): D1Result<T> }
      ).runSync()))();
    },
  } as unknown as D1Database;

  return {
    db,
    queries,
    setFailBatch(value: boolean) { failBatch = value; },
    setFailCredentialWriteAt(value: number | undefined) {
      options.failCredentialWriteAt = value;
      credentialWriteCount = 0;
    },
  };
}

function database(options: DatabaseOptions = {}) {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL,
      channel_access_token TEXT,
      channel_secret TEXT,
      login_channel_secret TEXT
    );
    CREATE TABLE tenant_line_accounts (
      tenant_id TEXT NOT NULL,
      line_account_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, line_account_id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
    );
    INSERT INTO tenants VALUES
      ('tenant-a', 'active'), ('tenant-b', 'active'), ('tenant-suspended', 'suspended');
  `);
  sqlite.prepare(`INSERT INTO line_accounts
    (id, is_active, channel_access_token, channel_secret, login_channel_secret)
    VALUES (?, ?, ?, ?, ?)`).run(
      'account-a', 1, ACCESS_TOKEN, CHANNEL_SECRET, LOGIN_CHANNEL_SECRET,
    );
  sqlite.prepare(`INSERT INTO line_accounts
    (id, is_active, channel_access_token, channel_secret, login_channel_secret)
    VALUES (?, ?, ?, ?, ?)`).run(
      'account-b', 1, OTHER_ACCESS_TOKEN, CHANNEL_SECRET, null,
    );
  sqlite.prepare(`INSERT INTO line_accounts
    (id, is_active, channel_access_token, channel_secret, login_channel_secret)
    VALUES (?, ?, ?, ?, ?)`).run(
      'account-inactive', 0, ACCESS_TOKEN, CHANNEL_SECRET, LOGIN_CHANNEL_SECRET,
    );
  sqlite.exec(`
    INSERT INTO tenant_line_accounts VALUES
      ('tenant-a', 'account-a'),
      ('tenant-b', 'account-b'),
      ('tenant-suspended', 'account-inactive');
  `);
  sqlite.exec(readFileSync(MIGRATION, 'utf8'));

  const fake = d1From(sqlite, options);
  return {
    ...fake,
    sqlite,
    close: () => sqlite.close(),
  };
}

function addMapping(sqlite: SqliteDatabase, tenantId: string, lineAccountId: string): void {
  sqlite.prepare(
    'INSERT INTO tenant_line_accounts (tenant_id, line_account_id) VALUES (?, ?)',
  ).run(tenantId, lineAccountId);
}

function credentialRows(
  sqlite: SqliteDatabase,
  lineAccountId = 'account-a',
): Array<{
  tenant_id: string;
  line_account_id: string;
  credential_kind: string;
  revision: number;
}> {
  return sqlite.prepare(`SELECT tenant_id, line_account_id, credential_kind, revision
    FROM pharmacy_line_credentials WHERE line_account_id = ? ORDER BY credential_kind`).all(lineAccountId) as Array<{
      tenant_id: string;
      line_account_id: string;
      credential_kind: string;
      revision: number;
    }>;
}

function legacyValues(sqlite: SqliteDatabase, accountId = 'account-a') {
  return sqlite.prepare(`SELECT channel_access_token, channel_secret, login_channel_secret
    FROM line_accounts WHERE id = ?`).get(accountId) as {
      channel_access_token: string | null;
      channel_secret: string | null;
      login_channel_secret: string | null;
    };
}

async function seedCredential(
  db: D1Database,
  kind: LineCredentialKind,
  credential: string,
  tenantId = 'tenant-a',
  lineAccountId = 'account-a',
): Promise<void> {
  await writeLineCredential(db, ROOT_SECRET, {
    tenantId,
    lineAccountId,
    kind,
    credential,
  });
}

describe('explicit tenant LINE credential migration', () => {
  it('backfills the three legacy secrets once, preserves existing rows, and is retry-safe', async () => {
    const fake = database();
    try {
      await seedCredential(fake.db, 'channel_access_token', ACCESS_TOKEN);
      const first = await backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      });

      expect(first).toEqual({ written: 2, verified: 1 });
      expect(credentialRows(fake.sqlite)).toEqual([
        { tenant_id: 'tenant-a', line_account_id: 'account-a', credential_kind: 'channel_access_token', revision: 1 },
        { tenant_id: 'tenant-a', line_account_id: 'account-a', credential_kind: 'channel_secret', revision: 1 },
        { tenant_id: 'tenant-a', line_account_id: 'account-a', credential_kind: 'login_channel_secret', revision: 1 },
      ]);
      expect(fake.queries.filter(({ sql }) => sql.includes('line-credential-backfill:legacy'))).toHaveLength(1);
      expect(first).not.toHaveProperty('credentials');

      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ written: 0, verified: 3 });
      expect(credentialRows(fake.sqlite).map(({ revision }) => revision)).toEqual([1, 1, 1]);
    } finally {
      fake.close();
    }
  });

  it('rejects duplicate active mappings before writing', async () => {
    const fake = database();
    try {
      addMapping(fake.sqlite, 'tenant-b', 'account-a');
      const before = legacyValues(fake.sqlite);
      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(credentialRows(fake.sqlite)).toEqual([]);
      expect(legacyValues(fake.sqlite)).toEqual(before);
    } finally {
      fake.close();
    }
  });

  it('rejects a wrong tenant, suspended tenant, and missing key without writes', async () => {
    const fake = database();
    try {
      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-b', lineAccountId: 'account-a',
      })).rejects.toThrow();
      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-suspended', lineAccountId: 'account-inactive',
      })).rejects.toThrow();
      const queriesBeforeMissingKey = fake.queries.length;
      await expect(backfillLineCredentials(fake.db, 'short', {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(fake.queries).toHaveLength(queriesBeforeMissingKey);
      expect(credentialRows(fake.sqlite)).toEqual([]);
    } finally {
      fake.close();
    }
  });

  it.each([
    ['mismatch', (sqlite: SqliteDatabase) => {
      return seedCredentialForMutation(sqlite, 'channel_access_token', OTHER_ACCESS_TOKEN);
    }],
    ['corrupt ciphertext', (sqlite: SqliteDatabase) => {
      return seedCredentialForMutation(sqlite, 'channel_access_token', ACCESS_TOKEN, true);
    }],
  ])('%s never overwrites an existing encrypted row or writes partial state', async (_label, mutate) => {
    const fake = database();
    try {
      await mutate(fake.sqlite);
      const before = credentialRows(fake.sqlite);
      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(credentialRows(fake.sqlite)).toEqual(before);
      expect(legacyValues(fake.sqlite)).toMatchObject({
        channel_access_token: ACCESS_TOKEN,
        channel_secret: CHANNEL_SECRET,
      });
    } finally {
      fake.close();
    }
  });

  it('resumes after an interrupted missing-credential write', async () => {
    const fake = database();
    try {
      fake.setFailCredentialWriteAt(2);
      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(credentialRows(fake.sqlite)).toHaveLength(1);

      fake.setFailCredentialWriteAt(undefined);
      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ written: 2, verified: 1 });
      expect(credentialRows(fake.sqlite)).toHaveLength(3);
    } finally {
      fake.close();
    }
  });

  it('backfills and scrubs mapped inactive accounts while operational reads stay active-only', async () => {
    const fake = database();
    try {
      fake.sqlite.prepare("UPDATE tenants SET status = 'active' WHERE id = 'tenant-suspended'").run();

      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-suspended', lineAccountId: 'account-inactive',
      })).resolves.toEqual({ written: 3, verified: 0 });
      expect(credentialRows(fake.sqlite, 'account-inactive')).toHaveLength(3);
      await expect(readLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-suspended', lineAccountId: 'account-inactive',
        kind: 'channel_access_token',
      })).resolves.toBeNull();

      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-suspended', lineAccountId: 'account-inactive',
      })).resolves.toEqual({ scrubbed: true, verified: 3 });
      expect(legacyValues(fake.sqlite, 'account-inactive')).toEqual({
        channel_access_token: LEGACY_SENTINEL,
        channel_secret: LEGACY_SENTINEL,
        login_channel_secret: LEGACY_SENTINEL,
      });
    } finally {
      fake.close();
    }
  });

  it('scrubs only after every applicable secret matches and keeps account state', async () => {
    const fake = database();
    try {
      await backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      });
      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ scrubbed: true, verified: 3 });
      expect(legacyValues(fake.sqlite)).toEqual({
        channel_access_token: LEGACY_SENTINEL,
        channel_secret: LEGACY_SENTINEL,
        login_channel_secret: LEGACY_SENTINEL,
      });
      expect(fake.sqlite.prepare('SELECT COUNT(*) AS count FROM line_accounts WHERE id = ?').get('account-a'))
        .toEqual({ count: 1 });
      expect(fake.sqlite.prepare('SELECT COUNT(*) AS count FROM tenant_line_accounts WHERE line_account_id = ?').get('account-a'))
        .toEqual({ count: 1 });

      await expect(backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ written: 0, verified: 3 });

      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ scrubbed: false, verified: 3 });
    } finally {
      fake.close();
    }
  });

  it('restores verified plaintext before rolling back to a legacy Worker', async () => {
    const fake = database();
    try {
      await backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      });
      await scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      });

      await expect(restoreLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ restored: true, verified: 3 });
      expect(legacyValues(fake.sqlite)).toEqual({
        channel_access_token: ACCESS_TOKEN,
        channel_secret: CHANNEL_SECRET,
        login_channel_secret: LOGIN_CHANNEL_SECRET,
      });
      await expect(restoreLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toEqual({ restored: false, verified: 3 });
    } finally {
      fake.close();
    }
  });

  it('does not scrub a partial encrypted state', async () => {
    const fake = database();
    try {
      await seedCredential(fake.db, 'channel_access_token', ACCESS_TOKEN);
      const before = legacyValues(fake.sqlite);
      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(legacyValues(fake.sqlite)).toEqual(before);
    } finally {
      fake.close();
    }
  });

  it('does not scrub a mismatch or corrupt encrypted state', async () => {
    const fake = database();
    try {
      await seedCredential(fake.db, 'channel_access_token', OTHER_ACCESS_TOKEN);
      await seedCredential(fake.db, 'channel_secret', CHANNEL_SECRET);
      await seedCredential(fake.db, 'login_channel_secret', LOGIN_CHANNEL_SECRET);
      const before = legacyValues(fake.sqlite);
      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(legacyValues(fake.sqlite)).toEqual(before);
    } finally {
      fake.close();
    }
  });

  it('retries an interrupted atomic scrub without deleting or closing anything', async () => {
    const fake = database();
    try {
      await backfillLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      });
      fake.setFailBatch(true);
      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).rejects.toThrow();
      expect(legacyValues(fake.sqlite).channel_access_token).toBe(ACCESS_TOKEN);

      fake.setFailBatch(false);
      await expect(scrubLegacyLineCredentials(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a',
      })).resolves.toMatchObject({ scrubbed: true });
      expect(fake.sqlite.prepare('SELECT is_active FROM line_accounts WHERE id = ?').get('account-a'))
        .toEqual({ is_active: 1 });
      expect(credentialRows(fake.sqlite)).toHaveLength(3);
    } finally {
      fake.close();
    }
  });
});

async function seedCredentialForMutation(
  sqlite: SqliteDatabase,
  kind: LineCredentialKind,
  credential: string,
  corrupt = false,
): Promise<void> {
  const fake = d1From(sqlite);
  await seedCredential(fake.db, kind, credential);
  if (corrupt) {
    sqlite.prepare(`UPDATE pharmacy_line_credentials
      SET ciphertext = 'corrupt' WHERE credential_kind = ?`).run(kind);
  }
}
