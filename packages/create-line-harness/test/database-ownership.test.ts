import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  const repo = mkdtempSync(join(tmpdir(), 'line-harness-f23-repo-'));
  mkdirSync(join(repo, 'packages/db/migrations'), { recursive: true });
  writeFileSync(join(repo, 'packages/db/schema.sql'), 'CREATE TABLE line_accounts (id TEXT);\n');
  return repo;
}

describe('createDatabaseForBenchmark', () => {
  it('reports ownership before schema work can fail', async () => {
    const repo = repoFixture();
    const receipt: { databaseId: string; databaseName: string }[] = [];
    wranglerMock
      .mockResolvedValueOnce('database_id = "created-id"')
      .mockRejectedValueOnce(new Error('schema failed'));

    await expect(
      createDatabaseForBenchmark(repo, 'bench-db', (value) => receipt.push(value)),
    ).rejects.toThrow('schema failed');
    expect(receipt).toEqual([{ databaseId: 'created-id', databaseName: 'bench-db' }]);
  });

  it('fails on a name collision without listing or reusing the existing database', async () => {
    wranglerMock.mockRejectedValueOnce(
      new WranglerError('create failed', 'database already exists'),
    );

    await expect(
      createDatabaseForBenchmark(repoFixture(), 'bench-db', () => undefined),
    ).rejects.toMatchObject({ stderr: 'database already exists' });
    expect(wranglerMock).toHaveBeenCalledTimes(1);
    expect(wranglerMock).toHaveBeenCalledWith(['d1', 'create', 'bench-db']);
  });
});
