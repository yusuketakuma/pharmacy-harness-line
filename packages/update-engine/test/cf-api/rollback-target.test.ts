import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRollbackPagesDeployment } from '../../src/cf-api/rollback-target.js';

const creds = { accountId: 'acct123', apiToken: 'tok_abc' };
const canonical = {
  id: 'production-deployment',
  environment: 'production',
  is_skipped: false,
  latest_stage: { name: 'deploy', status: 'success' },
};

describe('getRollbackPagesDeployment', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('uses the canonical production deployment instead of a newer list entry', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      success: true, result: { canonical_deployment: canonical },
    }) } as Response);

    await expect(getRollbackPagesDeployment({ creds, projectName: 'admin-project' }))
      .resolves.toEqual({ id: 'production-deployment' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/pages/projects/admin-project');
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer tok_abc' } });
  });

  it.each([
    ['no canonical deployment', null],
    ['preview deployment', { ...canonical, environment: 'preview' }],
    ['failed deployment', { ...canonical, latest_stage: { name: 'deploy', status: 'failure' } }],
    ['pending deployment', { ...canonical, latest_stage: { name: 'deploy', status: 'active' } }],
    ['skipped deployment', { ...canonical, is_skipped: true }],
    ['missing id', { ...canonical, id: '' }],
  ])('fails closed for %s', async (_case, deployment) => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      success: true, result: { canonical_deployment: deployment },
    }) } as Response);
    await expect(getRollbackPagesDeployment({ creds, projectName: 'admin-project' }))
      .rejects.toThrow(/rollback target is unavailable or unhealthy/);
  });

  it('rejects a failed project API response', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' } as Response);
    await expect(getRollbackPagesDeployment({ creds, projectName: 'admin-project' }))
      .rejects.toThrow(/HTTP 500/);
  });
});
