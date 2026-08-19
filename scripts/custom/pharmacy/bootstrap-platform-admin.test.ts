import { describe, expect, it, vi } from 'vitest';
import { runPlatformAdminBootstrap } from './bootstrap-platform-admin.js';

const args = [
  '--worker-url', 'https://api.example.test',
  '--admin-id', 'platform-owner',
  '--admin-name', 'Platform Owner',
  '--admin-email', 'platform@example.test',
];
const environment = { PHARMACY_PLATFORM_ADMIN_KEY: 'platform-secret-value' };

function created(status = 201) {
  return new Response(JSON.stringify({
    success: true,
    data: { staffId: 'staff-1', adminLoginId: 'platform-owner', replayed: false },
  }), { status, headers: { 'content-type': 'application/json' } });
}

function replayed() {
  return new Response(JSON.stringify({
    success: true,
    data: { staffId: 'staff-1', adminLoginId: 'platform-owner', replayed: true },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('platform admin bootstrap CLI', () => {
  it('dry-runs without sending or printing the platform key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const exitCode = await runPlatformAdminBootstrap(
      [...args, '--dry-run'], environment, fetcher, (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('Dry run passed');
    expect(output.join('\n')).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_KEY);
  });

  it('requires the platform key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const exitCode = await runPlatformAdminBootstrap(args, {}, fetcher, (line) => output.push(line));

    expect(exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('PHARMACY_PLATFORM_ADMIN_KEY is required');
  });

  it('posts to the CLI provisioning namespace and prints the one-time password', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(created());
    const exitCode = await runPlatformAdminBootstrap(
      args, environment, fetcher, (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/platform/pharmacy/platform-admins');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((init?.headers as Record<string, string>).Authorization)
      .toBe(`Bearer ${environment.PHARMACY_PLATFORM_ADMIN_KEY}`);
    const body = JSON.parse(String(init?.body)) as { temporaryPassword: string; loginId: string };
    expect(body.loginId).toBe('platform-owner');
    expect(body.temporaryPassword).toMatch(/^Tmp-[A-Za-z0-9_-]{32}$/);
    const rendered = output.join('\n');
    expect(rendered).toContain('管理者ID: platform-owner');
    expect(rendered).toContain(`仮パスワード（初回のみ表示）: ${body.temporaryPassword}`);
    expect(rendered).not.toContain(environment.PHARMACY_PLATFORM_ADMIN_KEY);
  });

  it('never derives the password from the platform key or the idempotency key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(created());
    const withKey = [...args, '--idempotency-key', 'replay-key-0001'];
    await runPlatformAdminBootstrap(withKey, environment, fetcher, () => {});
    await runPlatformAdminBootstrap(withKey, environment, fetcher, () => {});

    const [first, second] = fetcher.mock.calls
      .map(([, init]) => JSON.parse(String(init?.body)).temporaryPassword as string);
    // Same key, same login id, same idempotency key — a holder of all three
    // must still be unable to recompute the credential offline.
    expect(first).not.toBe(second);
    expect(first).toMatch(/^Tmp-[A-Za-z0-9_-]{32}$/);
  });

  it('prints no credential on a replay, only how to recover one', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(replayed());
    const exitCode = await runPlatformAdminBootstrap(
      args, environment, fetcher, (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body)).temporaryPassword as string;
    const rendered = output.join('\n');
    expect(rendered).toContain('既に作成済み');
    expect(rendered).not.toContain(sent);
    expect(rendered).toContain('再発行');
  });

  it('prints this run\'s password when a lost first attempt is what created the admin', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(replayed());
    const exitCode = await runPlatformAdminBootstrap(
      args, environment, fetcher, (line) => output.push(line),
    );

    expect(exitCode).toBe(0);
    const sent = JSON.parse(String(fetcher.mock.calls[1][1]?.body)).temporaryPassword as string;
    expect(output.join('\n')).toContain(sent);
  });

  it('prints no credential when the server rejects the key', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    const exitCode = await runPlatformAdminBootstrap(
      args, environment, fetcher, (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    const rendered = output.join('\n');
    expect(rendered).toContain('Platform admin bootstrap failed (401): Unauthorized');
    expect(rendered).not.toContain('仮パスワード');
  });

  it('retries a network failure once and reports failure without a credential', async () => {
    const output: string[] = [];
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'));
    const exitCode = await runPlatformAdminBootstrap(
      args, environment, fetcher, (line) => output.push(line),
    );

    expect(exitCode).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.join('\n')).not.toContain('仮パスワード');
  });
});
