import { describe, expect, it, vi } from 'vitest';
import { runTenantAdminBootstrap } from './bootstrap-tenant-admin.js';

const args = ['--worker-url', 'https://api.example.test', '--tenant-id', 'tenant-a'];

describe('retired tenant admin bootstrap CLI', () => {
  it('does not send a request or generate tenant credentials', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();

    const exitCode = await runTenantAdminBootstrap(
      args,
      {},
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('廃止されています');
  });

  it('explains the shared-password replacement in help', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();

    const exitCode = await runTenantAdminBootstrap(
      ['--help'],
      {},
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('共通パスワード');
  });
});
