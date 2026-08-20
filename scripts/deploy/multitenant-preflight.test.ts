import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMultitenantDataPreflight } from './multitenant-preflight.js';

const response = (counts: number[]) => ({
  success: true,
  result: [{
    results: ['login_channel_id', 'liff_id', 'account_line_user', 'unowned_line_user']
      .map((check_name, index) => ({ check_name, duplicate_groups: counts[index] ?? 0 })),
  }],
});

describe('multi-tenant migration data preflight', () => {
  it('runs before the production migration applier', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./apply-migrations.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('await runMultitenantDataPreflight');
    expect(source.indexOf('await runMultitenantDataPreflight')).toBeLessThan(
      source.indexOf('await applyD1Migrations({'),
    );
  });

  it('passes only after checking all uniqueness assumptions', async () => {
    const execute = vi.fn().mockResolvedValue(response([0, 0, 0, 0]));

    await expect(runMultitenantDataPreflight(execute, {
      creds: { accountId: 'account-a', apiToken: 'synthetic-token' },
      databaseId: 'database-a',
    })).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].sql).toContain('login_channel_id');
    expect(execute.mock.calls[0]?.[0].sql).toContain('line_account_id, line_user_id');
  });

  it('matches the friend indexes by ignoring NULL but retaining empty identities', async () => {
    const execute = vi.fn().mockResolvedValue(response([0, 0, 0, 0]));

    await expect(runMultitenantDataPreflight(execute, {
      creds: { accountId: 'account-a', apiToken: 'synthetic-token' },
      databaseId: 'database-a',
    })).resolves.toBeUndefined();

    const sql = execute.mock.calls[0]?.[0].sql as string;
    expect(sql.match(/line_user_id IS NOT NULL/g)).toHaveLength(2);
    expect(sql).not.toMatch(/line_user_id\s*!=\s*''/);
  });

  it('fails before migration when any selector is ambiguous', async () => {
    const execute = vi.fn().mockResolvedValue(response([0, 1, 0, 0]));

    await expect(runMultitenantDataPreflight(execute, {
      creds: { accountId: 'account-a', apiToken: 'synthetic-token' },
      databaseId: 'database-a',
    })).rejects.toThrow('multi-tenant migration preflight failed');
  });

  it('fails closed when the complete result set is unavailable', async () => {
    const execute = vi.fn().mockResolvedValue({ success: true, result: [{ results: [] }] });

    await expect(runMultitenantDataPreflight(execute, {
      creds: { accountId: 'account-a', apiToken: 'synthetic-token' },
      databaseId: 'database-a',
    })).rejects.toThrow('multi-tenant migration preflight failed');
  });
});
