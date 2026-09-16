import { afterEach, describe, expect, it, vi } from 'vitest';

const { createDatabaseForBenchmarkMock, wranglerMock } = vi.hoisted(() => ({
  createDatabaseForBenchmarkMock: vi.fn(),
  wranglerMock: vi.fn(),
}));

vi.mock('../packages/create-line-harness/src/steps/database.ts', () => ({
  createDatabaseForBenchmark: createDatabaseForBenchmarkMock,
}));
vi.mock('../packages/create-line-harness/src/lib/wrangler.ts', () => ({
  setAccountId: vi.fn(),
  wrangler: wranglerMock,
}));

import { cleanupDatabase, runCase } from './benchmark-create-database.ts';

afterEach(() => {
  createDatabaseForBenchmarkMock.mockReset();
  wranglerMock.mockReset();
});

function createOwned(id = 'created-id', name = 'bench-db') {
  createDatabaseForBenchmarkMock.mockImplementationOnce(
    async (_repo: string, _databaseName: string, onCreated: (receipt: { databaseId: string; databaseName: string }) => void) => {
      onCreated({ databaseId: id, databaseName: name });
      return { databaseId: id, databaseName: name };
    },
  );
}

describe('benchmark database ownership', () => {
  it('does not delete when creation failed before ownership was reported', async () => {
    createDatabaseForBenchmarkMock.mockRejectedValueOnce(new Error('create failed'));

    await expect(runCase('legacy', '/repo', 'bench-db')).rejects.toThrow('create failed');
    expect(wranglerMock).not.toHaveBeenCalled();
  });

  it('does not reuse or delete an existing name', async () => {
    createDatabaseForBenchmarkMock.mockRejectedValueOnce(new Error('already exists'));

    await expect(runCase('legacy', '/repo', 'bench-db')).rejects.toThrow('already exists');
    expect(wranglerMock).not.toHaveBeenCalled();
  });

  it('deletes only a newly created database after a schema failure', async () => {
    createDatabaseForBenchmarkMock.mockImplementationOnce(
      async (_repo: string, _databaseName: string, onCreated: (receipt: { databaseId: string; databaseName: string }) => void) => {
        onCreated({ databaseId: 'created-id', databaseName: 'bench-db' });
        throw new Error('schema failed');
      },
    );
    wranglerMock
      .mockResolvedValueOnce(JSON.stringify([{ name: 'bench-db', uuid: 'created-id' }]))
      .mockResolvedValueOnce('');

    await expect(runCase('legacy', '/repo', 'bench-db')).rejects.toThrow('schema failed');
    expect(wranglerMock).toHaveBeenNthCalledWith(1, ['d1', 'list', '--json']);
    expect(wranglerMock).toHaveBeenNthCalledWith(2, ['d1', 'delete', 'bench-db', '--skip-confirmation']);
  });

  it('refuses deletion if the name now belongs to a different database', async () => {
    createOwned();
    wranglerMock.mockResolvedValueOnce(JSON.stringify([{ name: 'bench-db', uuid: 'other-id' }]));

    await expect(runCase('legacy', '/repo', 'bench-db')).rejects.toThrow('ownership changed');
    expect(wranglerMock).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failure without hiding the operation failure', async () => {
    const operationError = new Error('schema failed');
    createDatabaseForBenchmarkMock.mockImplementationOnce(
      async (_repo: string, _databaseName: string, onCreated: (receipt: { databaseId: string; databaseName: string }) => void) => {
        onCreated({ databaseId: 'created-id', databaseName: 'bench-db' });
        throw operationError;
      },
    );
    const cleanupError = new Error('delete failed');
    wranglerMock
      .mockResolvedValueOnce(JSON.stringify([{ name: 'bench-db', uuid: 'created-id' }]))
      .mockRejectedValueOnce(cleanupError);

    try {
      await runCase('legacy', '/repo', 'bench-db');
      throw new Error('expected runCase to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([operationError, cleanupError]);
    }
  });

  it('skips cleanup when no ownership receipt exists', async () => {
    await expect(cleanupDatabase(null)).resolves.toBeUndefined();
    expect(wranglerMock).not.toHaveBeenCalled();
  });
});
