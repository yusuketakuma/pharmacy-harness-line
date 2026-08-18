import { describe, expect, it, vi } from 'vitest';
import { runTenantAdminBootstrap } from './bootstrap-tenant-admin.js';

const args = [
  '--worker-url', 'https://api.example.test',
  '--tenant-id', 'tenant-a',
  '--admin-id', 'admin-a',
  '--admin-name', 'Owner A',
  '--admin-email', 'owner@example.test',
];
const environment = { PHARMACY_PLATFORM_ADMIN_KEY: 'platform-secret-value' };

describe('tenant admin bootstrap CLI', () => {
  it('dry-runs without sending or printing the platform key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const exitCode = await runTenantAdminBootstrap(
      [...args, '--dry-run'],
      environment,
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('Dry run passed');
    expect(output.join('\n')).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_KEY);
  });

  it('issues and displays a one-time temporary password without echoing the platform key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        tenantCode: 'pharmacy-a',
        adminLoginId: 'admin-a',
        replayed: false,
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const exitCode = await runTenantAdminBootstrap(
      args,
      environment,
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/platform/pharmacy/tenants/tenant-a/admin-bootstrap');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = JSON.parse(String(init?.body)) as { temporaryPassword: string };
    expect(body.temporaryPassword).toMatch(/^Tmp-[A-Za-z0-9_-]{32}$/);
    const rendered = output.join('\n');
    expect(rendered).toContain('薬局コード: pharmacy-a');
    expect(rendered).toContain('管理者ID: admin-a');
    expect(rendered).toContain(`仮パスワード（初回のみ表示）: ${body.temporaryPassword}`);
    expect(rendered).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_KEY);
  });

  it('retries a network failure with the same password and prints no credential on failure', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: 'Tenant admin is already configured',
      }), { status: 409, headers: { 'content-type': 'application/json' } }));

    const exitCode = await runTenantAdminBootstrap(
      args,
      environment,
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(secondBody.temporaryPassword).toBe(firstBody.temporaryPassword);
    expect(output.join('\n')).not.toContain(firstBody.temporaryPassword);
    expect(output.join('\n')).toContain('Tenant admin is already configured');
  });

  it('reuses a supplied idempotency key with a reproducible temporary password', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { tenantCode: 'pharmacy-a', adminLoginId: 'admin-a' },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const retryArgs = [...args, '--idempotency-key', 'bootstrap-retry-20260819'];

    await runTenantAdminBootstrap(retryArgs, environment, fetcher, (line) => output.push(line));
    await runTenantAdminBootstrap(retryArgs, environment, fetcher, (line) => output.push(line));

    const first = fetcher.mock.calls[0][1]!;
    const second = fetcher.mock.calls[1][1]!;
    expect((first.headers as Record<string, string>)['Idempotency-Key'])
      .toBe('bootstrap-retry-20260819');
    expect((second.headers as Record<string, string>)['Idempotency-Key'])
      .toBe('bootstrap-retry-20260819');
    expect(JSON.parse(String(first.body)).temporaryPassword)
      .toBe(JSON.parse(String(second.body)).temporaryPassword);
    expect(output.filter((line) => line.includes('再実行キー')).length).toBe(2);
  });
});
