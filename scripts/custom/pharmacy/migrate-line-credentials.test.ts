import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runLineCredentialMigration } from './migrate-line-credentials.js';

const args = [
  '--worker-url', 'https://worker.example.test',
  '--tenant-id', 'tenant:pharmacy-a',
  '--line-account-id', 'account-a',
  '--phase', 'backfill',
];

describe('tenant LINE credential migration CLI', () => {
  it.each([
    'scripts/custom/pharmacy/setup-tenant.ts',
    'scripts/custom/pharmacy/bootstrap-tenant-admin.ts',
    'scripts/custom/pharmacy/migrate-line-credentials.ts',
  ])('runs the %s entrypoint under the repository CJS package', (entrypoint) => {
    const result = spawnSync('pnpm', ['exec', 'tsx', entrypoint, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    'tenant:setup',
    'tenant:admin-bootstrap',
    'tenant:line-credentials',
  ])('accepts pnpm argument forwarding for %s', (script) => {
    const result = spawnSync('pnpm', [script, '--', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('calls the explicit platform phase without putting secrets in the body or output', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { written: 3, verified: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const output: string[] = [];

    await expect(runLineCredentialMigration(
      args,
      { PHARMACY_PLATFORM_ADMIN_KEY: 'platform-secret-value' },
      fetcher,
      (line) => output.push(line),
    )).resolves.toBe(0);

    expect(fetcher).toHaveBeenCalledWith(
      'https://worker.example.test/api/platform/pharmacy/tenants/tenant%3Apharmacy-a/line-accounts/account-a/credentials/backfill',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer platform-secret-value' },
      }),
    );
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
    expect(output.join('\n')).not.toContain('platform-secret-value');
  });

  it('requires a separate human confirmation before scrub', async () => {
    const fetcher = vi.fn();
    const output: string[] = [];
    const scrubArgs = args.map((value) => value === 'backfill' ? 'scrub' : value);

    await expect(runLineCredentialMigration(
      scrubArgs,
      { PHARMACY_PLATFORM_ADMIN_KEY: 'platform-secret-value' },
      fetcher,
      (line) => output.push(line),
    )).resolves.toBe(1);

    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--confirm-scrub');
  });

  it('requires explicit confirmation before restoring plaintext for a legacy Worker rollback', async () => {
    const fetcher = vi.fn();
    const output: string[] = [];
    const restoreArgs = args.map((value) => value === 'backfill' ? 'restore' : value);

    await expect(runLineCredentialMigration(
      restoreArgs,
      { PHARMACY_PLATFORM_ADMIN_KEY: 'platform-secret-value' },
      fetcher,
      (line) => output.push(line),
    )).resolves.toBe(1);

    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--confirm-restore');
  });
});
