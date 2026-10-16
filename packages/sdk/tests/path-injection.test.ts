import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http.js';
import { FriendsResource } from '../src/resources/friends.js';
import { ScenariosResource } from '../src/resources/scenarios.js';
import { FormsResource } from '../src/resources/forms.js';
import { StaffResource } from '../src/resources/staff.js';

afterEach(() => vi.unstubAllGlobals());
it('keeps malicious identifiers inside their URL segments with auth attached', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const http = new HttpClient({
    baseUrl: 'https://worker.example.test',
    apiKey: 'synthetic',
    tenantId: 'tenant-a',
    timeout: 1000,
  });
  const id = '../line-accounts/account-b?';
  await new FriendsResource(http).setMetadata(id, { synthetic: true });
  await new ScenariosResource(http).updateStep(id, id, {});
  await new FormsResource(http).delete(id);
  await new StaffResource(http).delete(id);
  for (const [raw] of fetch.mock.calls as unknown as Array<[string]>) {
    const url = new URL(raw);
    expect(url.pathname).toContain('..%2Fline-accounts%2Faccount-b%3F');
    expect(url.search).toBe('');
    expect(url.pathname.startsWith('/api/line-accounts')).toBe(false);
  }
  const before = fetch.mock.calls.length;
  await expect(new FriendsResource(http).get('..')).rejects.toThrow('Invalid path identifier');
  expect(fetch).toHaveBeenCalledTimes(before);
});
