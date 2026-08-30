import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, toToolResult } from '../src/api-call.js';

describe('MCP API calls', () => {
  beforeEach(() => {
    process.env.LINE_HARNESS_API_URL = 'https://tenant.example';
    process.env.LINE_HARNESS_API_KEY = 'test-key';
    process.env.LINE_HARNESS_TENANT_ID = 'tenant-a';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the configured tenant header and distinguishes a missing route from a missing resource', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: false, error: 'Not found' }),
      { status: 404, headers: { 'X-Line-Harness-Error': 'route_not_found' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiCall('/api/entry-routes');
    const toolResult = toToolResult(result);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://tenant.example/api/entry-routes',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Tenant-Id': 'tenant-a' }),
      }),
    );
    expect(result.hint).toContain('この環境に存在しません');
    expect(toolResult.isError).toBe(true);
  });

  it('does not label a missing resource as a missing bundle route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: false, error: 'Not found' }),
      { status: 404 },
    )));

    const result = await apiCall('/api/entry-routes/missing');

    expect(result.hint).toBeUndefined();
  });

  it('redacts a non-JSON upstream error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'sensitive-upstream-detail',
      { status: 502 },
    )));

    const result = await apiCall('/api/entry-routes');

    expect(JSON.stringify(result.data)).not.toContain('sensitive-upstream-detail');
    expect(result.data).toMatchObject({ error: 'API 502 returned a non-JSON response' });
  });

  it('redacts fields from a JSON upstream error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        success: false,
        error: 'sensitive-upstream-detail',
        detail: 'credential-like-detail',
        stack: 'private-stack',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )));

    const result = await apiCall('/api/message-templates');

    expect(result.data).toEqual({
      success: false,
      error: 'API request failed (502)',
    });
  });
});
