import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { wranglerMock, WranglerError } = vi.hoisted(() => {
  class TestWranglerError extends Error {
    constructor(message: string, public readonly stderr: string) {
      super(message);
    }
  }
  return { wranglerMock: vi.fn(), WranglerError: TestWranglerError };
});

vi.mock('../src/lib/wrangler.js', () => ({
  wrangler: wranglerMock,
  WranglerError,
}));

import { createDatabaseForBenchmark } from '../src/steps/database.js';

afterEach(() => {
  wranglerMock.mockReset();
});

function repoFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'line-harness-f18-repo-'));
  mkdirSync(join(repo, 'packages/db/migrations'), { recursive: true });
  writeFileSync(join(repo, 'packages/db/schema.sql'), 'CREATE TABLE line_accounts (id TEXT);\n');
  writeFileSync(
    join(repo, 'packages/db/migrations/001_init.sql'),
    'CREATE TABLE mig_a (id TEXT);\nCREATE TABLE mig_b (id TEXT);\n',
  );
  return repo;
}

const isLedgerFileCall = (args: string[]) =>
  args.includes('--file') && args.some((arg) => arg.includes('line-harness-ledger-'));

describe('migration ledger only records fully applied files', () => {
  it('replays a partially applied file statement-by-statement before ledgering it', async () => {
    const repo = repoFixture();
    let ledgerSql = '';
    wranglerMock.mockImplementation(async (args: string[]) => {
      if (args[1] === 'create') return 'database_id = "created-id"';
      if (args.includes('--file') && args.some((arg) => arg.endsWith('001_init.sql'))) {
        throw new WranglerError('apply failed', 'table mig_a already exists');
      }
      if (args.includes('--command') && args.some((arg) => arg.includes('CREATE TABLE mig_a'))) {
        throw new WranglerError('apply failed', 'table mig_a already exists');
      }
      if (args.includes('--command') && args.some((arg) => arg.includes('sqlite_master'))) {
        return 'line_accounts';
      }
      if (isLedgerFileCall(args)) {
        ledgerSql = readFileSync(args[args.indexOf('--file') + 1], 'utf-8');
      }
      return '';
    });

    await expect(
      createDatabaseForBenchmark(repo, 'bench-db', () => undefined),
    ).resolves.toEqual({ databaseId: 'created-id', databaseName: 'bench-db' });

    // The partially applied file was replayed per statement before ledgering.
    const commandCalls = wranglerMock.mock.calls.filter(
      (call) => (call[0] as string[]).includes('--command'),
    );
    expect(
      commandCalls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('CREATE TABLE mig_b')),
      ),
    ).toBe(true);
    expect(ledgerSql).toContain('001_init.sql');
  });

  it('does not ledger a file whose statements cannot all be applied', async () => {
    const repo = repoFixture();
    wranglerMock.mockImplementation(async (args: string[]) => {
      if (args[1] === 'create') return 'database_id = "created-id"';
      if (args.includes('--file') && args.some((arg) => arg.endsWith('001_init.sql'))) {
        throw new WranglerError('apply failed', 'table mig_a already exists');
      }
      if (args.includes('--command') && args.some((arg) => arg.includes('CREATE TABLE mig_a'))) {
        throw new WranglerError('apply failed', 'table mig_a already exists');
      }
      if (args.includes('--command') && args.some((arg) => arg.includes('CREATE TABLE mig_b'))) {
        throw new WranglerError('syntax error near "mig_b"', 'syntax error near "mig_b"');
      }
      if (args.includes('--command') && args.some((arg) => arg.includes('sqlite_master'))) {
        return 'line_accounts';
      }
      return '';
    });

    await expect(
      createDatabaseForBenchmark(repo, 'bench-db', () => undefined),
    ).rejects.toThrow(/mig_b/);

    expect(
      wranglerMock.mock.calls.some((call) => isLedgerFileCall(call[0] as string[])),
    ).toBe(false);
  });

  it('falls back to schema + per-migration files when the bootstrap bundle cannot be split', async () => {
    const repo = repoFixture();
    // The generated bootstrap aggregates every migration, so it can mix
    // CREATE TRIGGER and CASE — the combination the statement splitter
    // fails closed on. An interrupted bootstrap must not wedge here.
    writeFileSync(
      join(repo, 'packages/db/bootstrap.sql'),
      'CREATE TRIGGER trg AFTER INSERT ON line_accounts BEGIN SELECT 1; END;\n' +
        'CREATE INDEX idx_case ON line_accounts ((julianday(CASE WHEN id IS NULL THEN 0 ELSE 1 END)));\n',
    );
    writeFileSync(
      join(repo, 'packages/db/bootstrap-meta.json'),
      JSON.stringify({ includedMigrations: ['001_init.sql'] }),
    );

    let ledgerSql = '';
    wranglerMock.mockImplementation(async (args: string[]) => {
      if (args[1] === 'create') return 'database_id = "created-id"';
      if (args.includes('--file') && args.some((arg) => arg.endsWith('bootstrap.sql'))) {
        throw new WranglerError('apply failed', 'table line_accounts already exists');
      }
      if (args.includes('--command') && args.some((arg) => arg.includes('sqlite_master'))) {
        return 'line_accounts';
      }
      if (isLedgerFileCall(args)) {
        ledgerSql = readFileSync(args[args.indexOf('--file') + 1], 'utf-8');
      }
      return '';
    });

    await expect(
      createDatabaseForBenchmark(repo, 'bench-db', () => undefined),
    ).resolves.toEqual({ databaseId: 'created-id', databaseName: 'bench-db' });

    // schema.sql and the migration file were applied directly instead of
    // crashing inside the bootstrap statement replay.
    const fileCalls = wranglerMock.mock.calls.filter(
      (call) => (call[0] as string[]).includes('--file'),
    );
    expect(
      fileCalls.some((call) =>
        (call[0] as string[]).some((arg) => arg.endsWith('schema.sql')),
      ),
    ).toBe(true);
    expect(
      fileCalls.some((call) =>
        (call[0] as string[]).some((arg) => arg.endsWith('001_init.sql')),
      ),
    ).toBe(true);
    expect(ledgerSql).toContain('001_init.sql');
  });
});
