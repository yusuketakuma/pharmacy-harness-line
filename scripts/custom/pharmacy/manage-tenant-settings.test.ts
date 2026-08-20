import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCredentialFile, runTenantSettings } from './manage-tenant-settings.js';

const baseArgs = [
  '--worker-url', 'https://api.example.test',
  '--tenant-id', 'tenant-a',
];
const environment = {
  PHARMACY_PLATFORM_ADMIN_LOGIN_ID: 'platform-owner',
  PHARMACY_PLATFORM_ADMIN_PASSWORD: 'platform-password-value',
};
const platformSession = `pas_${'a'.repeat(43)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function loginResponse(): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', `lh_platform_admin_session=${platformSession}; Path=/api/platform-admin; HttpOnly`);
  headers.append('set-cookie', 'lh_platform_admin_csrf=csrf-value; Path=/api/platform-admin');
  return new Response(JSON.stringify({
    success: true,
    data: { id: 'platform-admin-1', mustChangePassword: false },
    csrfToken: 'csrf-value',
  }), { status: 200, headers });
}

const logoutResponse = () => new Response(JSON.stringify({ success: true }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

describe('tenant settings CLI', () => {
  it('does not block preflight when optional pharmacy capabilities are OFF', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{
        id: 'account-a', liffIdConfigured: true, loginChannelConfigured: true,
        messagingCredentialsReady: true, loginCredentialReady: true,
        expectedLiffEndpoint: 'https://liff.example.test/?liffId=liff-a',
        liffEndpointEvidence: { status: 'READY' },
        readiness: {
          electronicPrescription: { status: 'BLOCKED', capabilityEnabled: false },
          emergencyContraception: { status: 'BLOCKED', capabilityEnabled: false },
        },
      }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    await expect(runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--preflight'], environment, fetcher,
      async () => Buffer.alloc(0), (line) => output.push(line),
    )).resolves.toBe(0);
    expect(output.join('\n')).toContain('"status": "READY"');
  });

  it('runs an account-scoped read-only preflight and stops activation on UNVERIFIED', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{
        id: 'account-a', liffIdConfigured: true, loginChannelConfigured: true,
        messagingCredentialsReady: true, loginCredentialReady: true,
        expectedLiffEndpoint: 'https://liff.example.test/?liffId=liff-a',
        liffEndpointEvidence: { status: 'UNVERIFIED', source: 'manual_console', checkedAt: null },
        readiness: {
          electronicPrescription: { status: 'UNVERIFIED' },
          emergencyContraception: { status: 'READY' },
        },
      }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--preflight'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher.mock.calls[1][0]).toBe('https://api.example.test/api/platform-admin/tenants/tenant-a/line-status');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(output.join('\n')).toContain('UNVERIFIED');
    expect(output.join('\n')).not.toContain(platformSession);
  });

  it('rejects applying a read-only preflight before login', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];
    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--preflight', '--apply'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );
    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--apply');
  });

  it('reads only an owner-only local credential file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenant-settings-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'ph-id');
    writeFileSync(path, 'platform-owner', { mode: 0o600 });

    expect(readCredentialFile(path)).toBe('platform-owner');
    chmodSync(path, 0o644);
    expect(readCredentialFile(path)).toBeUndefined();
  });

  it('reads a tenant-scoped admin API with a platform-admin session', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { value: 'https://example.test' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', '/api/account-settings/link-base-url'],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/api/platform-admin/login');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      loginId: environment.PHARMACY_PLATFORM_ADMIN_LOGIN_ID,
      password: environment.PHARMACY_PLATFORM_ADMIN_PASSWORD,
    });
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe('https://api.example.test/api/account-settings/link-base-url');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${platformSession}`,
      'X-Tenant-Id': 'tenant-a',
    });
    expect(output.join('\n')).toContain('"value": "https://example.test"');
    expect(output.join('\n')).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_PASSWORD);
    expect(output.join('\n')).not.toContain(platformSession);
    expect(fetcher.mock.calls[2][0]).toBe('https://api.example.test/api/platform-admin/logout');
  });

  it('uses stored credentials when environment variables are absent', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', '/api/settings'],
      {},
      fetcher,
      async () => Buffer.alloc(0),
      () => undefined,
      (service) => service === 'ph-id' ? 'platform-owner' : 'platform-password-value',
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      loginId: 'platform-owner',
      password: 'platform-password-value',
    });
  });

  it('accepts the deployed tenant:id format', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [
        '--worker-url', 'https://api.example.test',
        '--tenant-id', 'tenant:pharmacy-a',
        '--path', '/api/settings',
      ],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      () => undefined,
    );

    expect(exitCode).toBe(0);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      'X-Tenant-Id': 'tenant:pharmacy-a',
    });
  });

  it('dry-runs mutations unless --apply is present', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();

    const exitCode = await runTenantSettings(
      [...baseArgs, '--method', 'PUT', '--path', '/api/account-settings/link-base-url', '--input', 'settings.json'],
      environment,
      fetcher,
      async () => Buffer.from('{"value":"https://example.test"}'),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('Dry run');
    expect(output.join('\n')).not.toContain('https://example.test');
  });

  it('applies a JSON mutation without printing its body or key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--method', 'PATCH', '--path', '/api/line-accounts/account-a', '--input', 'settings.json', '--apply'],
      environment,
      fetcher,
      async () => Buffer.from('{"channelAccessToken":"line-secret"}'),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    const [, init] = fetcher.mock.calls[1];
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(String(init?.body)).toBe('{"channelAccessToken":"line-secret"}');
    expect(output.join('\n')).toContain('PATCH completed');
    expect(output.join('\n')).not.toContain('line-secret');
    expect(output.join('\n')).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_PASSWORD);
  });

  it('sets a rich menu as default through the confirmation-token flow', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { dryRun: true, confirmationToken: 'confirmation-secret' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { mode: 'set-default', enabled: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--rich-menu-default', 'group-a', '--apply'],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetcher.mock.calls.slice(1, 3)) {
      expect(url).toBe('https://api.example.test/api/rich-menu-groups/group-a/apply-to-tag?accountId=account-a');
      expect(init).toMatchObject({ method: 'POST' });
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${platformSession}`,
        'X-Tenant-Id': 'tenant-a',
        'Content-Type': 'application/json',
      });
    }
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      mode: 'set-default', enabled: true, dryRun: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      mode: 'set-default', enabled: true, dryRun: false, confirmationToken: 'confirmation-secret',
    });
    expect(output.join('\n')).toContain('Default rich menu updated');
    expect(output.join('\n')).not.toContain('confirmation-secret');
  });

  it('does not change the default rich menu without --apply', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--rich-menu-default', 'group-a'],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('Dry run');
  });

  it('stops when the rich menu preview does not return a confirmation token', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { dryRun: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--rich-menu-default', 'group-a', '--apply'],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(output.join('\n')).toContain('confirmation token');
  });

  it.each([
    'https://evil.example/api/settings',
    '//evil.example/api/settings',
    '/api/platform/pharmacy/tenants',
    '/api/liff/pharmacy/patients',
  ])('rejects a path outside tenant admin APIs: %s', async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', path],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON before sending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [...baseArgs, '--method', 'PUT', '--path', '/api/settings', '--input', 'settings.json', '--apply'],
      environment,
      fetcher,
      async () => Buffer.from('{invalid'),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('valid JSON');
  });

  it('requires a tenant and platform-admin credentials before sending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      ['--worker-url', 'https://api.example.test', '--path', '/api/settings'],
      {},
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toMatch(/tenant-id|PHARMACY_PLATFORM_ADMIN/);
  });
});
