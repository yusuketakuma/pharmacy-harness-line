import { describe, expect, it, vi } from 'vitest';
import {
  applyD1Migrations,
  buildMigrationLedgerSql,
  migrationChecksum,
  splitSqlStatements,
} from '../src/migrations.js';

const creds = { accountId: 'account', apiToken: 'token' };

describe('splitSqlStatements', () => {
  it('rejects destructive table rebuilds', () => {
    expect(() => splitSqlStatements('DROP TABLE friends;')).toThrow(
      'destructive schema changes',
    );
    expect(() => splitSqlStatements('ALTER TABLE old RENAME TO current;')).toThrow(
      'destructive schema changes',
    );
  });
  it('splits statements while preserving semicolons inside strings and comments', () => {
    const sql = `
      -- first; comment
      CREATE TABLE demo (value TEXT);
      INSERT INTO demo VALUES ('a;b');
      /* block; comment */ UPDATE demo SET value = "c;d";
    `;

    expect(splitSqlStatements(sql)).toEqual([
      '-- first; comment\n      CREATE TABLE demo (value TEXT)',
      "INSERT INTO demo VALUES ('a;b')",
      '/* block; comment */ UPDATE demo SET value = "c;d"',
    ]);
  });

  it('ignores empty and comment-only fragments', () => {
    expect(splitSqlStatements('-- only a comment;\n; /* another */')).toEqual([]);
  });

  it('keeps a simple trigger body atomic while splitting following statements', () => {
    expect(splitSqlStatements(
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; INSERT INTO c VALUES (NEW.id); END; CREATE INDEX i ON b(x);',
    )).toEqual([
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = 1; INSERT INTO c VALUES (NEW.id); END',
      'CREATE INDEX i ON b(x)',
    ]);
  });

  it('fails closed for trigger grammar that needs a full SQL parser', () => {
    expect(() => splitSqlStatements(
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET x = CASE WHEN x = 1 THEN 2 ELSE 3 END; END;',
    )).toThrow(/CASE-bearing CREATE TRIGGER/);
  });
});

describe('buildMigrationLedgerSql', () => {
  it('creates an idempotent checksum baseline without overwriting prior evidence', () => {
    const sql = buildMigrationLedgerSql(
      ["041_patient's.sql"],
      new Map([["041_patient's.sql", Buffer.from('SELECT 1;')]]),
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS _line_harness_migrations');
    expect(sql).toContain('INSERT OR IGNORE INTO _line_harness_migrations');
    expect(sql).toContain("041_patient''s.sql");
    expect(sql).toMatch(/sha256:[0-9a-f]{64}/);
  });
});

describe('applyD1Migrations', () => {
  it('executes migration SQL and its checksum ledger insert atomically', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const execute = vi.fn(async (opts: { sql: string; params?: any[] }) => {
      calls.push(opts);
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return { success: true, result: [{ results: [] }] };
      }
      return { success: true, result: [] };
    });

    await applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['041_demo.sql'],
      migrations: new Map([
        ['041_demo.sql', Buffer.from('CREATE TABLE one (id TEXT); CREATE TABLE two (id TEXT);')],
      ]),
      execute: execute as any,
    });

    expect(calls).toHaveLength(3);
    expect(calls[2].sql).toContain('CREATE TABLE one');
    expect(calls[2].sql).toContain('CREATE TABLE two');
    expect(calls[2].sql).toContain('INSERT INTO _line_harness_migrations');
  });

  it('fails closed before migration when an existing database has no checksum ledger', async () => {
    const execute = vi.fn(async () => ({ success: true, result: [{ results: [] }] }));

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['041_demo.sql'],
        migrations: new Map([['041_demo.sql', Buffer.from('CREATE TABLE demo (id TEXT);')]]),
        requireChecksumLedger: true,
        execute: execute as any,
      }),
    ).rejects.toThrow(/checksum ledger missing/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts an ambiguous response only after rereading the matching checksum', async () => {
    const source = Buffer.from('CREATE TABLE demo (id TEXT);');
    const { createHash } = await import('node:crypto');
    const checksum = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    let checksumReads = 0;
    const execute = vi.fn(async (opts: { sql: string }) => {
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        checksumReads += 1;
        return {
          success: true,
          result: [{ results: checksumReads === 1 ? [] : [{ checksum }] }],
        };
      }
      throw new Error('network response lost');
    });

    const [result] = await applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['041_demo.sql'],
      migrations: new Map([['041_demo.sql', source]]),
      execute: execute as any,
    });

    expect(result).toMatchObject({ alreadyApplied: false, executedStatements: 1 });
    expect(checksumReads).toBe(2);
  });

  it('fails atomically instead of guessing that a duplicate schema error is benign', async () => {
    const calls: Array<{ sql: string; params?: any[] }> = [];
    const execute = vi.fn(async (opts: { sql: string; params?: any[] }) => {
      calls.push({ sql: opts.sql, params: opts.params });
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return { success: true, result: [{ results: [] }] };
      }
      if (opts.sql.includes('ADD COLUMN existing')) {
        throw new Error('duplicate column name: existing');
      }
      return { success: true, result: [] };
    });

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['046_partial.sql'],
        migrations: new Map([
          [
            '046_partial.sql',
            Buffer.from(
              'ALTER TABLE demo ADD COLUMN existing TEXT; ALTER TABLE demo ADD COLUMN missing TEXT;',
            ),
          ],
        ]),
        execute: execute as any,
      }),
    ).rejects.toThrow(/failed atomically: duplicate column/);
    expect(calls.some((call) => call.sql.includes('ADD COLUMN missing'))).toBe(true);
    expect(calls.some((call) => call.sql.includes('INSERT INTO _line_harness_migrations'))).toBe(true);
  });

  it('stops without a ledger row when D1 answers success:false', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (opts: { sql: string; params?: any[] }) => {
      calls.push(opts.sql);
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [] }] };
      }
      if (opts.sql.includes(`CREATE TABLE ${'_line_harness_migrations'}`)) {
        return { success: true, result: [] };
      }
      // Cloudflare answers a failed statement with HTTP 200 + success:false.
      return { success: false, result: [] };
    });

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['041_first.sql', '042_second.sql'],
        migrations: new Map([
          ['041_first.sql', Buffer.from('CREATE TABLE first (id TEXT);')],
          ['042_second.sql', Buffer.from('CREATE TABLE second (id TEXT);')],
        ]),
        execute: execute as any,
      }),
    ).rejects.toThrow(/D1 query failed/);
    expect(calls.some((sql) => sql.includes('INSERT INTO _line_harness_migrations'))).toBe(false);
    expect(calls.some((sql) => sql.includes('CREATE TABLE second'))).toBe(false);
  });

  it('never starts the next migration when an atomic apply answers success:false', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (opts: { sql: string; params?: any[] }) => {
      calls.push(opts.sql);
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return { success: true, result: [{ results: [] }] };
      }
      return { success: false, result: [], errors: [{ message: 'FOREIGN KEY constraint failed' }] };
    });

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['041_first.sql', '042_second.sql'],
        migrations: new Map([
          ['041_first.sql', Buffer.from('CREATE TABLE first (id TEXT);')],
          ['042_second.sql', Buffer.from('CREATE TABLE second (id TEXT);')],
        ]),
        execute: execute as any,
      }),
    ).rejects.toThrow(/041_first\.sql failed atomically.*FOREIGN KEY constraint failed/s);
    expect(calls.some((sql) => sql.includes('CREATE TABLE second'))).toBe(false);
  });

  it('skips a legacy trigger whose live definition already matches', async () => {
    const trigger =
      "CREATE TRIGGER IF NOT EXISTS friends_account_immutable BEFORE UPDATE OF line_account_id ON friends "
      + "WHEN OLD.line_account_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'FRIEND_ACCOUNT_IMMUTABLE'); END;";
    const writes: string[] = [];
    const execute = vi.fn(async (opts: { sql: string; params?: any[] }) => {
      if (opts.sql.includes("type='trigger'")) {
        return {
          success: true,
          result: [{
            results: [{
              // SQLite stores the definition without IF NOT EXISTS and reflows whitespace.
              sql: "CREATE TRIGGER friends_account_immutable\n  BEFORE UPDATE OF line_account_id ON friends\n"
                + "  WHEN OLD.line_account_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'FRIEND_ACCOUNT_IMMUTABLE'); END",
            }],
          }],
        };
      }
      if (opts.sql.includes('sqlite_master')) return { success: true, result: [{ results: [] }] };
      writes.push(opts.sql);
      return { success: true, result: [] };
    });

    const [result] = await applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['custom_016_demo.sql'],
      migrations: new Map([
        ['custom_016_demo.sql', Buffer.from(`CREATE TABLE demo (id TEXT);\n\n-- tenant integrity\n${trigger}`)],
      ]),
      execute: execute as any,
    });

    expect(result).toMatchObject({ executedStatements: 1, skippedStatements: 1 });
    expect(writes.some((sql) => sql.includes('CREATE TRIGGER'))).toBe(false);
    expect(writes.some((sql) => sql.includes('INSERT INTO _line_harness_migrations'))).toBe(true);
  });

  it('fails closed when a legacy trigger of the same name has a different body', async () => {
    const trigger =
      "CREATE TRIGGER IF NOT EXISTS friends_account_immutable BEFORE UPDATE OF line_account_id ON friends "
      + "WHEN OLD.line_account_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'FRIEND_ACCOUNT_IMMUTABLE'); END;";
    const liveSql =
      'CREATE TRIGGER friends_account_immutable BEFORE UPDATE OF line_account_id ON friends '
      + 'WHEN OLD.line_account_id IS NOT NULL BEGIN SELECT 1; END';
    const writes: string[] = [];
    const execute = vi.fn(async (opts: { sql: string; params?: any[] }) => {
      if (opts.sql.includes("type='trigger'")) {
        return { success: true, result: [{ results: [{ sql: liveSql }] }] };
      }
      if (opts.sql.includes('sqlite_master')) return { success: true, result: [{ results: [] }] };
      writes.push(opts.sql);
      return { success: true, result: [] };
    });

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['custom_016_demo.sql'],
        migrations: new Map([['custom_016_demo.sql', Buffer.from(trigger)]]),
        execute: execute as any,
      }),
    ).rejects.toThrow(/friends_account_immutable/);
    const message = await applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['custom_016_demo.sql'],
      migrations: new Map([['custom_016_demo.sql', Buffer.from(trigger)]]),
      execute: execute as any,
    }).catch((error: Error) => error.message);
    expect(message).toContain("RAISE(ABORT, 'FRIEND_ACCOUNT_IMMUTABLE')");
    expect(message).toContain('SELECT 1');
    expect(writes.some((sql) => sql.includes('INSERT INTO _line_harness_migrations'))).toBe(false);
  });

  it('skips a migration whose matching checksum is already recorded', async () => {
    const source = Buffer.from('CREATE TABLE demo (id TEXT);');
    const { createHash } = await import('node:crypto');
    const checksum = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    const execute = vi.fn(async (opts: { sql: string }) => {
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return {
          success: true,
          result: [{ results: [{ checksum }] }],
        };
      }
      return { success: true, result: [] };
    });

    const [result] = await applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['041_demo.sql'],
      migrations: new Map([['041_demo.sql', source]]),
      execute: execute as any,
    });

    expect(result.alreadyApplied).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2); // ledger existence + checksum SELECT
  });

  it('skips a checksum-matched historical migration before parsing pending SQL', async () => {
    const historical = Buffer.from('ALTER TABLE old_name RENAME TO current_name;');
    const additive = Buffer.from('CREATE TABLE added (id TEXT);');
    const writes: string[] = [];
    const execute = vi.fn(async (opts: { sql: string; params?: unknown[] }) => {
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return {
          success: true,
          result: [{
            results: opts.params?.[0] === '040_historical.sql'
              ? [{ checksum: migrationChecksum(historical) }]
              : [],
          }],
        };
      }
      writes.push(opts.sql);
      return { success: true, result: [] };
    });

    const results = await applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['040_historical.sql', '041_additive.sql'],
      migrations: new Map([
        ['040_historical.sql', historical],
        ['041_additive.sql', additive],
      ]),
      requireChecksumLedger: true,
      execute: execute as any,
    });

    expect(results).toEqual([
      {
        name: '040_historical.sql',
        alreadyApplied: true,
        executedStatements: 0,
        skippedStatements: 0,
      },
      {
        name: '041_additive.sql',
        alreadyApplied: false,
        executedStatements: 1,
        skippedStatements: 0,
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('CREATE TABLE added');
    expect(writes[0]).not.toContain('RENAME TO');
  });

  it('fails before any D1 write when the bundle is missing a declared migration', async () => {
    const execute = vi.fn();
    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['missing.sql'],
        migrations: new Map(),
        execute: execute as any,
      }),
    ).rejects.toThrow(/missing\.sql missing in bundle/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails before an earlier pending write when a later checksum mismatches', async () => {
    const writes: string[] = [];
    const onMigrationStart = vi.fn();
    const execute = vi.fn(async (opts: { sql: string; params?: unknown[] }) => {
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return {
          success: true,
          result: [{
            results: opts.params?.[0] === '042_applied.sql'
              ? [{ checksum: 'sha256:different' }]
              : [],
          }],
        };
      }
      writes.push(opts.sql);
      return { success: true, result: [] };
    });

    await expect(applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['041_pending.sql', '042_applied.sql'],
      migrations: new Map([
        ['041_pending.sql', Buffer.from('CREATE TABLE pending (id TEXT);')],
        ['042_applied.sql', Buffer.from('CREATE TABLE applied (id TEXT);')],
      ]),
      requireChecksumLedger: true,
      onMigrationStart,
      execute: execute as any,
    })).rejects.toThrow(/changed after it was applied/);
    expect(writes).toEqual([]);
    expect(onMigrationStart).not.toHaveBeenCalled();
  });

  it('fails before an earlier pending write when later pending SQL is destructive', async () => {
    const writes: string[] = [];
    const execute = vi.fn(async (opts: { sql: string }) => {
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return { success: true, result: [{ results: [] }] };
      }
      writes.push(opts.sql);
      return { success: true, result: [] };
    });

    await expect(applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['041_valid.sql', '042_destructive.sql'],
      migrations: new Map([
        ['041_valid.sql', Buffer.from('CREATE TABLE valid (id TEXT);')],
        ['042_destructive.sql', Buffer.from('DROP TABLE users;')],
      ]),
      requireChecksumLedger: true,
      execute: execute as any,
    })).rejects.toThrow(/destructive schema changes/);
    expect(writes).toEqual([]);
  });

  it('rejects duplicate migration names before D1 access', async () => {
    const execute = vi.fn();
    await expect(applyD1Migrations({
      creds,
      databaseId: 'db',
      names: ['041_demo.sql', '041_demo.sql'],
      migrations: new Map([['041_demo.sql', Buffer.from('CREATE TABLE demo (id TEXT);')]]),
      execute: execute as any,
    })).rejects.toThrow(/duplicate names/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses to bypass a checksum mismatch for historical destructive SQL', async () => {
    const execute = vi.fn(async (opts: { sql: string }) => {
      if (opts.sql.includes('sqlite_master')) {
        return { success: true, result: [{ results: [{ name: '_line_harness_migrations' }] }] };
      }
      if (opts.sql.includes('SELECT checksum')) {
        return {
          success: true,
          result: [{ results: [{ checksum: 'sha256:old' }] }],
        };
      }
      return { success: true, result: [] };
    });

    await expect(
      applyD1Migrations({
        creds,
        databaseId: 'db',
        names: ['041_demo.sql'],
        migrations: new Map([
          ['041_demo.sql', Buffer.from('ALTER TABLE old_name RENAME TO changed_name;')],
        ]),
        execute: execute as any,
      }),
    ).rejects.toThrow(/changed after it was applied/);
  });
});
