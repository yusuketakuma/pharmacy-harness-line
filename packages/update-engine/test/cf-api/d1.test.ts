import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeD1Query, getD1Bookmark } from '../../src/cf-api/d1.js';
import type { CfApiCreds } from '../../src/types.js';

const creds: CfApiCreds = {
  accountId: 'acct123',
  apiToken: 'tok_abc',
};

describe('executeD1Query', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('happy path — executes SQL and returns parsed JSON response', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const apiResponse = {
      success: true,
      result: [
        {
          results: [{ id: 1, name: 'alice' }],
          success: true,
          meta: { duration: 0.5 },
        },
      ],
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => apiResponse,
    } as Response);

    const out = await executeD1Query({
      creds,
      databaseId: 'db123',
      sql: 'SELECT * FROM users WHERE id = ?',
      params: [1],
    });

    expect(out).toEqual(apiResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on 400 (bad SQL) with informative message', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"errors":[{"message":"syntax error near SELEC"}]}',
    } as Response);

    await expect(
      executeD1Query({
        creds,
        databaseId: 'db123',
        sql: 'SELEC * FROM users',
        params: [],
      }),
    ).rejects.toThrow(/D1 query failed HTTP 400/);
  });

  it('throws on 401 (auth failure)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"errors":[{"message":"unauthorized"}]}',
    } as Response);

    await expect(
      executeD1Query({
        creds,
        databaseId: 'db123',
        sql: 'SELECT 1',
      }),
    ).rejects.toThrow(/D1 query failed HTTP 401/);
  });

  it('throws on HTTP 200 with an envelope that reports success:false', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        result: [],
        errors: [{ code: 7500, message: 'near "TRIGER": syntax error' }],
      }),
    } as unknown as Response);

    await expect(
      executeD1Query({ creds, databaseId: 'db123', sql: 'CREATE TRIGER t ...' }),
    ).rejects.toThrow(/D1 query failed.*7500.*syntax error/s);
  });

  it('throws when one statement of a multi-statement response failed', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          { success: true, results: [], meta: {} },
          { success: false, error: 'table friends has no column named tenant_id' },
        ],
      }),
    } as unknown as Response);

    await expect(
      executeD1Query({
        creds,
        databaseId: 'db123',
        sql: 'CREATE TABLE a (id TEXT); ALTER TABLE friends ADD COLUMN tenant_id TEXT;',
      }),
    ).rejects.toThrow(/statement 2.*no column named tenant_id/s);
  });

  it('passes params array correctly in body', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [] }),
    } as Response);

    await executeD1Query({
      creds,
      databaseId: 'db123',
      sql: 'INSERT INTO t (a, b, c) VALUES (?, ?, ?)',
      params: ['one', 2, true],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.sql).toBe('INSERT INTO t (a, b, c) VALUES (?, ?, ?)');
    expect(body.params).toEqual(['one', 2, true]);
  });

  it('defaults params to [] when not provided', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [] }),
    } as Response);

    await executeD1Query({
      creds,
      databaseId: 'db123',
      sql: 'SELECT 1',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.params).toEqual([]);
  });

  it('uses correct URL with accountId + databaseId interpolation and headers', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [] }),
    } as Response);

    await executeD1Query({
      creds,
      databaseId: 'db_xyz',
      sql: 'SELECT 1',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct123/d1/database/db_xyz/query',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('getD1Bookmark', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('captures the current Time Travel bookmark before migration', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { bookmark: 'bookmark-123' } }),
    } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getD1Bookmark({ creds, databaseId: 'db123' })).resolves.toBe(
      'bookmark-123',
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct123/d1/database/db123/time_travel/bookmark',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
  });

  it('fails when Cloudflare returns no bookmark', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: {} }),
    } as Response) as unknown as typeof fetch;

    await expect(getD1Bookmark({ creds, databaseId: 'db123' })).rejects.toThrow(
      /missing bookmark/,
    );
  });
});
