import { describe, expect, it, vi } from 'vitest';
import { runTenantSetup } from './setup-tenant.js';

const args = [
  '--worker-url', 'https://api.example.test',
  '--tenant-code', 'pharmacy-a',
  '--tenant-name', 'Pharmacy A',
  '--admin-id', 'admin-a',
  '--admin-name', 'Owner A',
  '--admin-email', 'owner@example.test',
  '--line-channel-id', '2001234567',
  '--line-name', 'Pharmacy A LINE',
  '--line-login-channel-id', '2007654321',
  '--liff-id', '2007654321-AbCdEfGh',
];

const secrets = {
  PHARMACY_PLATFORM_ADMIN_KEY: 'platform-secret-value',
  PHARMACY_LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-line-token-with-enough-length-1234567890',
  PHARMACY_LINE_CHANNEL_SECRET: '0123456789abcdef0123456789abcdef',
  PHARMACY_LINE_LOGIN_CHANNEL_SECRET: 'abcdef0123456789abcdef0123456789',
};

describe('tenant setup CLI', () => {
  it('dry-runs without sending or printing secrets', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const exitCode = await runTenantSetup(
      [...args, '--dry-run'],
      secrets,
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    const rendered = output.join('\n');
    expect(rendered).toContain('Dry run passed');
    expect(rendered).not.toContain(secrets.PHARMACY_PLATFORM_ADMIN_KEY);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_CHANNEL_ACCESS_TOKEN);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_CHANNEL_SECRET);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_LOGIN_CHANNEL_SECRET);
  });

  it('rejects a LIFF ID from another login channel before sending', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const mismatched = args.map((value) =>
      value === '2007654321-AbCdEfGh' ? '2999999999-AbCdEfGh' : value);

    const exitCode = await runTenantSetup(mismatched, secrets, fetcher, (line) => output.push(line));

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('LIFF ID must belong to --line-login-channel-id');
  });

  it('requires the LINE Login channel and LIFF identifiers for a pharmacy tenant', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const withoutLogin = args.filter((value) =>
      value !== '--line-login-channel-id' &&
      value !== '2007654321' &&
      value !== '2007654321-AbCdEfGh' &&
      value !== '--liff-id');

    const exitCode = await runTenantSetup(withoutLogin, secrets, fetcher, (line) => output.push(line));

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--line-login-channel-id');
  });

  it('provisions once and displays the issued login details without echoing LINE secrets', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        tenantCode: 'pharmacy-a',
        adminLoginId: 'admin-a',
        urls: {
          admin: 'https://admin.example.test',
          webhook: 'https://api.example.test/webhook',
          liffEndpoint: 'https://liff.example.test/?liffId=2007654321-AbCdEfGh',
        },
        line: { tokenValidated: true, webhookConfigured: true },
        manualSteps: ['Enable webhook use in LINE Developers if it is disabled.'],
      },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));

    const exitCode = await runTenantSetup(args, secrets, fetcher, (line) => output.push(line));

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/platform/pharmacy/tenants');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((init?.headers as Record<string, string>).Authorization)
      .toBe(`Bearer ${secrets.PHARMACY_PLATFORM_ADMIN_KEY}`);
    expect((init?.headers as Record<string, string>)['Idempotency-Key'])
      .toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(init?.body)) as {
      admin: { temporaryPassword: string };
      line: {
        channelAccessToken: string;
        channelSecret: string;
        loginChannelSecret: string | null;
      };
    };
    expect(body.admin.temporaryPassword).toMatch(/^Tmp-[A-Za-z0-9_-]{32}$/);
    expect(body.line).toMatchObject({
      channelAccessToken: secrets.PHARMACY_LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: secrets.PHARMACY_LINE_CHANNEL_SECRET,
      loginChannelSecret: secrets.PHARMACY_LINE_LOGIN_CHANNEL_SECRET,
    });

    const rendered = output.join('\n');
    expect(rendered).toContain('薬局コード: pharmacy-a');
    expect(rendered).toContain('管理者ID: admin-a');
    expect(rendered).toContain(`仮パスワード（初回のみ表示）: ${body.admin.temporaryPassword}`);
    expect(rendered).not.toContain('LINE Callback URL');
    expect(rendered).not.toContain(secrets.PHARMACY_PLATFORM_ADMIN_KEY);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_CHANNEL_ACCESS_TOKEN);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_CHANNEL_SECRET);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_LOGIN_CHANNEL_SECRET);
  });

  it('requires the LINE Login channel secret when a Login channel is configured', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const exitCode = await runTenantSetup(
      args,
      { ...secrets, PHARMACY_LINE_LOGIN_CHANNEL_SECRET: undefined },
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('PHARMACY_LINE_LOGIN_CHANNEL_SECRET');
  });

  it('reuses a supplied idempotency key and derives the same temporary password', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        tenantCode: 'pharmacy-a',
        adminLoginId: 'admin-a',
        urls: {},
        line: {},
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const retryArgs = [...args, '--idempotency-key', 'setup-retry-20260819'];

    await runTenantSetup(retryArgs, secrets, fetcher, (line) => output.push(line));
    await runTenantSetup(retryArgs, secrets, fetcher, (line) => output.push(line));

    const first = fetcher.mock.calls[0][1]!;
    const second = fetcher.mock.calls[1][1]!;
    expect((first.headers as Record<string, string>)['Idempotency-Key'])
      .toBe('setup-retry-20260819');
    expect((second.headers as Record<string, string>)['Idempotency-Key'])
      .toBe('setup-retry-20260819');
    expect(JSON.parse(String(first.body)).admin.temporaryPassword)
      .toBe(JSON.parse(String(second.body)).admin.temporaryPassword);
    expect(output.filter((line) => line.includes('再実行キー')).length).toBe(2);
  });

  it('derives a different temporary password for a different tenant reusing the same idempotency key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { tenantCode: 'pharmacy-a', adminLoginId: 'admin-a', urls: {}, line: {} },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const sharedIdempotencyKey = ['--idempotency-key', 'shared-lost-response-key'];
    const tenantAArgs = [...args, ...sharedIdempotencyKey];
    const tenantBArgs = args.map((value) => (value === 'pharmacy-a' ? 'pharmacy-b' : value))
      .concat(sharedIdempotencyKey);

    await runTenantSetup(tenantAArgs, secrets, fetcher, (line) => output.push(line));
    await runTenantSetup(tenantBArgs, secrets, fetcher, (line) => output.push(line));

    const first = fetcher.mock.calls[0][1]!;
    const second = fetcher.mock.calls[1][1]!;
    expect(JSON.parse(String(first.body)).admin.temporaryPassword)
      .not.toBe(JSON.parse(String(second.body)).admin.temporaryPassword);
  });

  it('fails before the request when required configuration is missing', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const exitCode = await runTenantSetup(
      args,
      { ...secrets, PHARMACY_PLATFORM_ADMIN_KEY: undefined },
      fetcher,
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('PHARMACY_PLATFORM_ADMIN_KEY');
  });

  it('reports a safe server error without echoing submitted credentials', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: 'LINE access token validation failed',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));

    const exitCode = await runTenantSetup(args, secrets, fetcher, (line) => output.push(line));

    expect(exitCode).toBe(1);
    const rendered = output.join('\n');
    expect(rendered).toContain('LINE access token validation failed');
    expect(rendered).not.toContain(secrets.PHARMACY_PLATFORM_ADMIN_KEY);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_CHANNEL_ACCESS_TOKEN);
    expect(rendered).not.toContain(secrets.PHARMACY_LINE_CHANNEL_SECRET);
  });
});
