import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  createEncryptedLineAccount,
  LINE_ACCOUNT_CONFLICT_ERROR,
  updateEncryptedLineAccount,
} from './line-account-store.js';
import { readLineCredential } from './line-credential-store.js';

const ROOT_SECRET = 'synthetic-root-secret-for-account-store-v1';
const ACCESS_TOKEN = `token-${'a'.repeat(64)}`;
const CHANNEL_SECRET = 'b'.repeat(32);
const require = createRequire(import.meta.url);
const Sqlite = require('../../../../../../packages/db/node_modules/better-sqlite3') as
  new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      reader: boolean;
      get(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
      run(...values: unknown[]): { changes: number };
    };
    transaction<T extends unknown[], R>(fn: (...args: T) => R): (...args: T) => R;
    close(): void;
  };

function database(batchError?: Error, updateChanges = 1) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const batch = vi.fn(async (items: typeof statements) => {
    if (batchError) throw batchError;
    return items.map((_, index) => ({
      success: true,
      results: [],
      meta: { changes: index === items.length - 1 ? updateChanges : 1 },
    }));
  });
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = {
            sql,
            values,
            async first<T>() {
              if (sql.includes('MAX(account.display_order)')) return { next: 1 } as T;
              if (sql.includes('FROM line_accounts AS account') && sql.includes('account.id = ?')) {
                return {
                  id: String(values[1]),
                  channel_id: 'channel-a',
                  name: 'Pharmacy A',
                  channel_access_token: 'encrypted:v1',
                  channel_secret: 'encrypted:v1',
                  login_channel_id: null,
                  login_channel_secret: null,
                  liff_id: null,
                  is_active: 1,
                  country: null,
                  role: null,
                  display_order: 1,
                  token_expires_at: null,
                  og_site_name: null,
                  og_default_image_url: null,
                  og_default_description: null,
                  created_at: '2026-08-18T00:00:00.000Z',
                  updated_at: '2026-08-18T00:00:00.000Z',
                } as T;
              }
              return null;
            },
          };
          statements.push(statement);
          return statement;
        },
      };
    },
    batch,
  } as unknown as D1Database;
  return { db, batch, statements };
}

function sqliteDatabase() {
  const sqlite = new Sqlite(':memory:');
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY, channel_id TEXT UNIQUE, name TEXT,
      channel_access_token TEXT, channel_secret TEXT,
      login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT,
      is_active INTEGER, display_order INTEGER, country TEXT, role TEXT,
      token_expires_at TEXT, og_site_name TEXT, og_default_image_url TEXT,
      og_default_description TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenant_line_accounts (
      tenant_id TEXT NOT NULL, line_account_id TEXT NOT NULL UNIQUE,
      created_at TEXT, updated_at TEXT,
      PRIMARY KEY (tenant_id, line_account_id)
    );
    CREATE TABLE pharmacy_line_credentials (
      tenant_id TEXT NOT NULL, line_account_id TEXT NOT NULL,
      credential_kind TEXT NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL,
      key_version INTEGER NOT NULL, revision INTEGER NOT NULL,
      lookup_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, line_account_id, credential_kind),
      UNIQUE (lookup_digest)
    );
    INSERT INTO tenants VALUES ('tenant-a', 'active');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active,
       display_order, created_at, updated_at)
    VALUES ('account-a', 'channel-a', 'Pharmacy A', 'encrypted:v1',
            'encrypted:v1', 1, 0, '2026-08-17T00:00:00.000Z',
            '2026-08-17T00:00:00.000Z');
    INSERT INTO tenant_line_accounts
      VALUES ('tenant-a', 'account-a', '2026-08-17T00:00:00.000Z',
              '2026-08-17T00:00:00.000Z');
  `);

  type Statement = { sql: string; values: unknown[] };
  const statement = (sql: string, values: unknown[] = []) => ({
    sql,
    values,
    bind(...next: unknown[]) { return statement(sql, next); },
    async first<T>() { return (sqlite.prepare(sql).get(...values) as T | undefined) ?? null; },
    async all<T>() {
      return { success: true, results: sqlite.prepare(sql).all(...values) as T[], meta: {} };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...values);
      return { success: true, results: [], meta: { changes: result.changes } };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (items: Statement[]) => sqlite.transaction((batchItems: Statement[]) =>
      batchItems.map(({ sql, values }) => {
        const prepared = sqlite.prepare(sql);
        if (prepared.reader) {
          return { success: true, results: prepared.all(...values), meta: { changes: 0 } };
        }
        const result = prepared.run(...values);
        return { success: true, results: [], meta: { changes: result.changes } };
      }))(items),
  } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}

describe('atomic encrypted LINE account creation', () => {
  it('creates the account, tenant mapping, and encrypted credentials in one D1 batch', async () => {
    const fake = database();

    const account = await createEncryptedLineAccount(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      channelId: 'channel-a',
      name: 'Pharmacy A',
      credentials: [
        { kind: 'channel_access_token', credential: ACCESS_TOKEN },
        { kind: 'channel_secret', credential: CHANNEL_SECRET },
      ],
    });

    expect(account.id).toBeTruthy();
    expect(fake.batch).toHaveBeenCalledTimes(1);
    expect(fake.batch.mock.calls[0]?.[0]).toHaveLength(4);
    const batchValues = fake.batch.mock.calls[0]![0].flatMap(({ values }) => values);
    expect(batchValues).not.toContain(ACCESS_TOKEN);
    expect(batchValues).not.toContain(CHANNEL_SECRET);
    expect(batchValues.filter((value) => value === 'encrypted:v1')).toHaveLength(2);
  });

  it('atomically assigns a pharmacy account to the creating staff member', async () => {
    const fake = database();

    const account = await createEncryptedLineAccount(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      channelId: 'channel-a',
      name: 'Pharmacy A',
      assignedStaffId: 'staff-a',
      credentials: [
        { kind: 'channel_access_token', credential: ACCESS_TOKEN },
        { kind: 'channel_secret', credential: CHANNEL_SECRET },
      ],
    });

    const batch = fake.batch.mock.calls[0]?.[0] ?? [];
    expect(batch).toHaveLength(5);
    expect(batch.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO pharmacy_staff_accounts'),
    ]));
    const assignment = batch.find(({ sql }) => sql.includes('pharmacy_staff_accounts'));
    expect(assignment?.values).toEqual(expect.arrayContaining([account.id, 'staff-a']));
  });

  it('does not continue after the atomic batch fails', async () => {
    const fake = database(new Error('batch failed'));

    await expect(createEncryptedLineAccount(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      channelId: 'channel-a',
      name: 'Pharmacy A',
      credentials: [
        { kind: 'channel_access_token', credential: ACCESS_TOKEN },
        { kind: 'channel_secret', credential: CHANNEL_SECRET },
      ],
    })).rejects.toThrow('Unable to create LINE account');
    expect(fake.batch).toHaveBeenCalledTimes(1);
  });
});

describe('atomic encrypted LINE account update', () => {
  it('updates credentials and metadata in one D1 batch without plaintext binds', async () => {
    const fake = database();

    await updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
      credentials: [
        { kind: 'channel_access_token', credential: ACCESS_TOKEN },
        { kind: 'channel_secret', credential: CHANNEL_SECRET },
      ],
      metadata: { country: 'JP', role: 'main' },
    });

    expect(fake.batch).toHaveBeenCalledTimes(1);
    expect(fake.batch.mock.calls[0]?.[0]).toHaveLength(3);
    const batchValues = fake.batch.mock.calls[0]![0].flatMap(({ values }) => values);
    expect(batchValues).not.toContain(ACCESS_TOKEN);
    expect(batchValues).not.toContain(CHANNEL_SECRET);
    expect(batchValues).toContain('encrypted:v1');
    expect(batchValues).toContain('JP');
  });

  it('deletes the Login secret and clears its metadata in the same batch', async () => {
    const fake = database();

    await updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
      credentials: [{ kind: 'login_channel_secret', credential: null }],
      metadata: { loginChannelId: null },
    });

    const batch = fake.batch.mock.calls[0]![0];
    expect(batch).toHaveLength(2);
    expect(batch[0]?.sql).toContain('DELETE FROM pharmacy_line_credentials');
    expect(batch[1]?.sql).toContain('UPDATE line_accounts');
  });

  it('rejects a stale account update without reporting success', async () => {
    const fake = database(undefined, 0);

    await expect(updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
      tenantId: 'tenant-a',
      lineAccountId: 'account-a',
      expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
      credentials: [{ kind: 'channel_secret', credential: CHANNEL_SECRET }],
      metadata: {},
    })).rejects.toThrow(LINE_ACCOUNT_CONFLICT_ERROR);
  });

  it('executes the atomic rotation and stale-write guard against SQLite', async () => {
    const fake = sqliteDatabase();
    try {
      const first = await updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a',
        lineAccountId: 'account-a',
        expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
        credentials: [
          { kind: 'channel_access_token', credential: ACCESS_TOKEN },
          { kind: 'channel_secret', credential: CHANNEL_SECRET },
        ],
        metadata: {},
      });
      expect(first.updated_at).not.toBe('2026-08-17T00:00:00.000Z');
      await expect(readLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
      })).resolves.toBe(ACCESS_TOKEN);

      await expect(updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a',
        lineAccountId: 'account-a',
        expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
        credentials: [{ kind: 'channel_access_token', credential: `stale-${'z'.repeat(64)}` }],
        metadata: {},
      })).rejects.toThrow(LINE_ACCOUNT_CONFLICT_ERROR);
      await expect(readLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a', lineAccountId: 'account-a', kind: 'channel_access_token',
      })).resolves.toBe(ACCESS_TOKEN);
    } finally {
      fake.close();
    }
  });

  it('preserves the Login secret when the tenant is suspended before clear commits', async () => {
    const fake = sqliteDatabase();
    try {
      const active = await updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a',
        lineAccountId: 'account-a',
        expectedUpdatedAt: '2026-08-17T00:00:00.000Z',
        credentials: [{ kind: 'login_channel_secret', credential: CHANNEL_SECRET }],
        metadata: { loginChannelId: 'login-channel-a' },
      });
      await fake.db.prepare(
        "UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-a'",
      ).run();

      await expect(updateEncryptedLineAccount(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a',
        lineAccountId: 'account-a',
        expectedUpdatedAt: active.updated_at,
        credentials: [{ kind: 'login_channel_secret', credential: null }],
        metadata: { loginChannelId: null },
      })).rejects.toThrow(LINE_ACCOUNT_CONFLICT_ERROR);

      const remaining = await fake.db.prepare(
        `SELECT COUNT(*) AS count
           FROM pharmacy_line_credentials
          WHERE tenant_id = 'tenant-a'
            AND line_account_id = 'account-a'
            AND credential_kind = 'login_channel_secret'`,
      ).first<{ count: number }>();
      expect(remaining?.count).toBe(1);
    } finally {
      fake.close();
    }
  });

  it('executes atomic account creation against SQLite', async () => {
    const fake = sqliteDatabase();
    try {
      const created = await createEncryptedLineAccount(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a',
        channelId: 'channel-b',
        name: 'Pharmacy B',
        credentials: [
          { kind: 'channel_access_token', credential: ACCESS_TOKEN },
          { kind: 'channel_secret', credential: CHANNEL_SECRET },
        ],
      });
      await expect(readLineCredential(fake.db, ROOT_SECRET, {
        tenantId: 'tenant-a',
        lineAccountId: created.id,
        kind: 'channel_access_token',
      })).resolves.toBe(ACCESS_TOKEN);
    } finally {
      fake.close();
    }
  });
});
