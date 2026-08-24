import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCredentialFile, runTenantSettings } from './manage-tenant-settings.js';
import {
  PHARMACY_ADMIN_API_COVERAGE,
  findPharmacyAdminApiDeferred,
} from '../../../apps/worker/src/custom/pharmacy/platform-admin/api-coverage.js';

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
  it('declares the required non-PHI API coverage and mutation gates', () => {
    const covered = (method: string, path: string) => PHARMACY_ADMIN_API_COVERAGE.some(
      (entry) => entry.method === method && entry.path.test(path),
    );

    expect(covered('GET', '/api/custom/pharmacy/readiness')).toBe(true);
    expect(covered('PUT', '/api/custom/pharmacy/growth/config')).toBe(true);
    expect(covered('PUT', '/api/custom/pharmacy/public-profile')).toBe(true);
    expect(covered('PUT', '/api/custom/pharmacy/myna-endpoint')).toBe(true);
    expect(covered('PATCH', '/api/custom/pharmacy/myna-endpoint')).toBe(true);
    expect(covered('POST', '/api/custom/pharmacy/myna-endpoint/verification')).toBe(true);
    expect(covered('GET', '/api/custom/pharmacy/emergency-contraception/config')).toBe(true);
    expect(covered('GET', '/api/custom/pharmacy/operations-summary')).toBe(true);
    expect(covered('GET', '/api/custom/pharmacy/active-work')).toBe(true);
    expect(covered('GET', '/api/custom/pharmacy/growth/dashboard')).toBe(true);
    expect(covered('PATCH', '/api/custom/pharmacy/growth/sources/source-a')).toBe(true);
    expect(covered('GET', '/api/custom/pharmacy/rich-menus/candidate')).toBe(true);
    expect(covered('GET', '/api/custom/pharmacy/rich-menus/versions/group-a/diff')).toBe(true);
    expect(covered('PUT', '/api/custom/pharmacy/rich-menus/layout')).toBe(true);
    expect(covered('PUT', '/api/custom/pharmacy/rich-menus/lifecycle')).toBe(true);
    expect(covered('POST', '/api/rich-menu-groups/group-a/publish')).toBe(true);
    expect(covered('GET', '/api/rich-menu-groups')).toBe(true);
    expect(covered('GET', '/api/rich-menu-groups/group-a')).toBe(true);
    expect(covered('GET', '/api/staff/staff-a/accounts')).toBe(true);
    expect(covered('GET', '/api/tags')).toBe(true);
    expect(covered('PATCH', '/api/staff/staff-a')).toBe(true);
    expect(covered('PUT', '/api/staff/staff-a/accounts')).toBe(true);
    expect(covered('POST', '/api/staff')).toBe(true);
    expect(covered('POST', '/api/staff/staff-a/reset-password')).toBe(true);
    expect(covered('DELETE', '/api/staff/staff-a')).toBe(true);
    expect(findPharmacyAdminApiDeferred('PATCH', '/api/staff/staff-a')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('PUT', '/api/staff/staff-a/accounts')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('POST', '/api/staff')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('POST', '/api/staff/staff-a/reset-password')).toBeUndefined();
    expect(findPharmacyAdminApiDeferred('DELETE', '/api/staff/staff-a')).toBeUndefined();
    expect(covered('POST', '/api/line-accounts/account-a/connect')).toBe(true);
    expect(covered('PATCH', '/api/line-accounts/order')).toBe(true);
    expect(PHARMACY_ADMIN_API_COVERAGE.every((entry) => entry.safeOutput || entry.secretOutput)).toBe(true);
    expect(PHARMACY_ADMIN_API_COVERAGE.find((entry) =>
      entry.path.test('/api/rich-menu-groups/group-a/publish'))?.mutationGate,
    ).toBe('confirmation');
  });

  it('reports missing configuration with stable doctor reason codes and exit code 2', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{
        id: 'account-a', liffIdConfigured: false, loginChannelConfigured: true,
        messagingCredentialsReady: false, loginCredentialReady: true,
        expectedLiffEndpoint: null,
        liffEndpointEvidence: { status: 'UNVERIFIED' },
        readiness: {
          electronicPrescription: { status: 'BLOCKED', capabilityEnabled: true },
          emergencyContraception: { status: 'READY', capabilityEnabled: true },
          richMenu: { status: 'BLOCKED', capabilityEnabled: true },
        },
        configurationDoctor: {
          accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z', status: 'BLOCKED',
          reasonCodes: [
            'LIFF_ID_MISSING', 'MESSAGING_CREDENTIAL_MISSING',
            'ELECTRONIC_ENDPOINT_MISSING', 'RICH_MENU_LAYOUT_MISSING',
          ],
          checks: [],
        },
      }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    await expect(runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--doctor'], environment, fetcher,
      async () => Buffer.alloc(0), (line) => output.push(line),
    )).resolves.toBe(2);
    expect(JSON.parse(output.join('\n'))).toMatchObject({
      status: 'BLOCKED',
      localCredentials: { loginIdConfigured: true, passwordConfigured: true },
      reasonCodes: [
        'LIFF_ID_MISSING',
        'MESSAGING_CREDENTIAL_MISSING',
        'ELECTRONIC_ENDPOINT_MISSING',
        'RICH_MENU_LAYOUT_MISSING',
      ],
    });
  });

  it('uses exit code 3 when doctor cannot verify the API state', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 401 }));

    await expect(runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--doctor'], environment, fetcher,
      async () => Buffer.alloc(0), (line) => output.push(line),
    )).resolves.toBe(3);
    expect(output.join('\n')).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_PASSWORD);
  });

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
          richMenu: { status: 'BLOCKED', capabilityEnabled: false },
        },
        configurationDoctor: {
          accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
          status: 'READY', reasonCodes: [], checks: [],
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
        configurationDoctor: {
          accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
          status: 'UNVERIFIED', reasonCodes: ['LIFF_ENDPOINT_UNVERIFIED'], checks: [],
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

  it('uses the canonical doctor projection instead of re-deriving legacy flags', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{
        id: 'account-a', liffIdConfigured: false, messagingCredentialsReady: false,
        configurationDoctor: {
          accountId: 'account-a', checkedAt: '2026-08-21T00:00:00.000Z',
          status: 'READY', reasonCodes: [], checks: [],
        },
      }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--doctor'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join('\n'))).toMatchObject({ status: 'READY', reasonCodes: [] });
    expect(fetcher.mock.calls[1][0]).toBe(
      'https://api.example.test/api/platform-admin/tenants/tenant-a/line-status?verifyLiffEndpoint=account-a',
    );
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

  it('pins a generic pharmacy API request to the explicit account', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, data: { variantKey: 'v4-empty' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [
        ...baseArgs,
        '--account-id', 'account-a',
        '--path', '/api/custom/pharmacy/rich-menus/layout?accountId=account-a',
      ],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      () => undefined,
    );

    expect(exitCode).toBe(0);
    expect(fetcher.mock.calls[1][0]).toBe(
      'https://api.example.test/api/custom/pharmacy/rich-menus/layout?accountId=account-a',
    );
  });

  it('rejects a generic pharmacy API account mismatch before login', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [
        ...baseArgs,
        '--account-id', 'account-a',
        '--path', '/api/custom/pharmacy/rich-menus/layout?accountId=account-b',
      ],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('account');
  });

  it('requires an account pin for every generic pharmacy API before login', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', '/api/custom/pharmacy/readiness?line_account_id=account-a'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--account-id is required');
  });

  it('rejects a line-account path that differs from the account pin', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];
    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--path', '/api/line-accounts/account-b'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );
    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('does not match');
  });

  it('rejects a line-account action path that differs from the account pin', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];
    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--account-id', 'account-a', '--method', 'POST',
        '--path', '/api/line-accounts/account-b/connect', '--input', 'settings.json',
      ],
      environment, fetcher, async () => Buffer.from('{}'), (line) => output.push(line),
    );
    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('does not match');
  });

  it('rejects an input account that differs from the account pin', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];
    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--account-id', 'account-a', '--method', 'PUT',
        '--path', '/api/custom/pharmacy/growth/config?line_account_id=account-a',
        '--input', 'settings.json',
      ],
      environment, fetcher,
      async () => Buffer.from('{"line_account_id":"account-b","expectedRevision":1}'),
      (line) => output.push(line),
    );
    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('input account');
  });

  it('rejects confirmation-gated rich-menu mutation through generic request options', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];
    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--account-id', 'account-a', '--method', 'POST',
        '--path', '/api/rich-menu-groups/group-a/publish?accountId=account-a',
        '--input', 'settings.json', '--apply',
      ],
      environment, fetcher, async () => Buffer.from('{"dryRun":false}'),
      (line) => output.push(line),
    );
    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('dedicated rich-menu option');
  });

  it('rejects --apply on a covered GET before login', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];
    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', '/api/account-settings/link-base-url', '--apply'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );
    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--apply cannot be used with GET');
  });

  it.each([
    '/api/custom/pharmacy/patients?line_account_id=account-a',
    '/api/custom/pharmacy/myna-handoffs?line_account_id=account-a',
    '/api/custom/pharmacy/emergency-contraception/intakes?line_account_id=account-a',
    '/api/friends',
    '/api/chats',
  ])('denies a PHI or operational route before login: %s', async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--path', path],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('coverage');
  });

  it('refuses to print a non-JSON GET response from a covered path', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response('unexpected body', { status: 200 }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', '/api/account-settings/link-base-url'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(output.join('\n')).not.toContain('unexpected body');
    expect(output.join('\n')).toContain('safe JSON');
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
      [...baseArgs, '--path', '/api/account-settings/link-base-url'],
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
        '--path', '/api/account-settings/link-base-url',
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
      [...baseArgs, '--account-id', 'account-a', '--method', 'PATCH', '--path', '/api/line-accounts/account-a', '--input', 'settings.json', '--apply'],
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

  it.each([
    ['PATCH', '/api/staff/staff-a', '{"role":"admin","isActive":true}'],
    ['PUT', '/api/staff/staff-a/accounts', '{"accountIds":["account-a"]}'],
  ])('applies a tenant-scoped staff authority change: %s %s', async (method, path, input) => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--method', method, '--path', path, '--input', 'staff.json', '--apply'],
      environment,
      fetcher,
      async () => Buffer.from(input),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher.mock.calls[1][0]).toBe(`https://api.example.test${path}`);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method, body: Buffer.from(input) });
    expect(output.join('\n')).toContain(`${method} completed for tenant tenant-a.`);
    expect(output.join('\n')).not.toContain(input);
  });

  it.each([
    ['POST', '/api/staff', '{"name":"New Staff","loginId":"new-staff","role":"staff"}'],
    ['POST', '/api/staff/staff-a/reset-password', '{}'],
  ])('writes a one-time staff credential only to a new owner-only file: %s %s', async (
    method,
    path,
    input,
  ) => {
    const directory = mkdtempSync(join(tmpdir(), 'tenant-settings-secret-'));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, 'temporary-password.json');
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { id: 'staff-a', temporaryPassword: 'Tmp-secret-value' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--method', method, '--path', path, '--input', 'staff.json',
        '--secret-output', secretPath, '--apply',
      ],
      environment,
      fetcher,
      async () => Buffer.from(input),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(secretPath, 'utf8'))).toMatchObject({
      success: true,
      data: { temporaryPassword: 'Tmp-secret-value' },
    });
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(output.join('\n')).toContain('Secret response written');
    expect(output.join('\n')).not.toContain('Tmp-secret-value');
  });

  it.each([
    ['POST', '/api/staff', '{"name":"New Staff","loginId":"new-staff","role":"staff"}'],
    ['POST', '/api/staff/staff-a/reset-password', '{}'],
  ])('preserves an explicit unknown-outcome marker after credential response loss: %s %s', async (
    method,
    path,
    input,
  ) => {
    const directory = mkdtempSync(join(tmpdir(), 'tenant-settings-secret-'));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, 'temporary-password.json');
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockRejectedValueOnce(new TypeError('network response lost'))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--method', method, '--path', path, '--input', 'staff.json',
        '--secret-output', secretPath, '--apply',
      ],
      environment,
      fetcher,
      async () => Buffer.from(input),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(readFileSync(secretPath, 'utf8'))).toMatchObject({
      status: 'UNKNOWN_OUTCOME',
      tenantId: 'tenant-a',
      method,
      path,
      recovery: 'verify_staff_then_reset_password',
    });
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(output.join('\n')).toContain('Do not retry blindly');
    expect(output.join('\n')).not.toContain('network response lost');
    expect(output.join('\n')).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_PASSWORD);
  });

  it('requires a secret output file before staff credential mutation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [...baseArgs, '--method', 'POST', '--path', '/api/staff', '--input', 'staff.json', '--apply'],
      environment,
      fetcher,
      async () => Buffer.from('{"name":"New Staff","loginId":"new-staff","role":"staff"}'),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('--secret-output is required');
  });

  it('does not overwrite an existing secret output file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tenant-settings-secret-'));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, 'temporary-password.json');
    writeFileSync(secretPath, 'keep-me', { mode: 0o600 });
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--method', 'POST', '--path', '/api/staff', '--input', 'staff.json',
        '--secret-output', secretPath, '--apply',
      ],
      environment,
      fetcher,
      async () => Buffer.from('{"name":"New Staff","loginId":"new-staff","role":"staff"}'),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFileSync(secretPath, 'utf8')).toBe('keep-me');
    expect(output.join('\n')).toContain('already exists');
  });

  it('applies a tenant-scoped staff deletion', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--method', 'DELETE', '--path', '/api/staff/staff-a', '--apply'],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher.mock.calls[1][0]).toBe('https://api.example.test/api/staff/staff-a');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
  });

  it('reports a stale revision without printing the response body or credentials', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false, error: 'stale expectedRevision secret-detail',
      }), { status: 409, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [
        ...baseArgs, '--account-id', 'account-a', '--method', 'PUT',
        '--path', '/api/custom/pharmacy/growth/config?line_account_id=account-a',
        '--input', 'settings.json', '--apply',
      ],
      environment, fetcher,
      async () => Buffer.from('{"expectedRevision":1,"capabilities":[],"proactiveMonthlyLimit":0}'),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(output.join('\n')).toContain('Request failed (409)');
    expect(output.join('\n')).not.toContain('secret-detail');
    expect(output.join('\n')).not.toContain(platformSession);
  });

  it('reads the tenant-scoped tag settings added to the shared coverage', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: [{ id: 'tag-a', name: 'priority' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--path', '/api/tags'],
      environment,
      fetcher,
      async () => Buffer.alloc(0),
      (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher.mock.calls[1][0]).toBe('https://api.example.test/api/tags');
    expect(output.join('\n')).toContain('priority');
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

  it('publishes a saved rich-menu version through its confirmation-token API', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, data: { dryRun: true, confirmationToken: 'publish-confirmation' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { pages: [] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--rich-menu-publish', 'group-a', '--apply'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher.mock.calls[1][0]).toBe(
      'https://api.example.test/api/rich-menu-groups/group-a/publish?accountId=account-a',
    );
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ dryRun: true });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      dryRun: false, confirmationToken: 'publish-confirmation',
    });
    expect(output.join('\n')).toContain('Rich menu version published');
    expect(output.join('\n')).not.toContain('publish-confirmation');
  });

  it('rolls back to a known-good rich menu through a fresh confirmation token', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, data: { dryRun: true, confirmationToken: 'rollback-confirmation' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(logoutResponse());

    const exitCode = await runTenantSettings(
      [...baseArgs, '--account-id', 'account-a', '--rich-menu-rollback', 'group-a', '--apply'],
      environment, fetcher, async () => Buffer.alloc(0), (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      mode: 'set-default', enabled: true, intent: 'rollback', dryRun: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      mode: 'set-default', enabled: true, intent: 'rollback', dryRun: false,
      confirmationToken: 'rollback-confirmation',
    });
    expect(output.join('\n')).toContain('rolled back');
    expect(output.join('\n')).not.toContain('rollback-confirmation');
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
      [...baseArgs, '--method', 'PUT', '--path', '/api/account-settings/link-base-url', '--input', 'settings.json', '--apply'],
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
