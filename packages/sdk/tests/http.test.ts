import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineHarness } from '../src/client.js'

afterEach(() => vi.unstubAllGlobals())

describe('tenant-bound SDK requests', () => {
  it('sends the configured tenant header on every request', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { items: [], total: 0, page: 1, limit: 50, hasNextPage: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', request)

    const client = new LineHarness({
      apiUrl: 'https://worker.example.test',
      apiKey: 'integration-key',
      tenantId: 'tenant-a',
    } as ConstructorParameters<typeof LineHarness>[0])
    await client.friends.list()

    const headers = new Headers(request.mock.calls[0][1]?.headers)
    expect(headers.get('X-Tenant-Id')).toBe('tenant-a')
  })

  it('fails closed when tenant scope is missing', () => {
    expect(() => new LineHarness({
      apiUrl: 'https://worker.example.test',
      apiKey: 'integration-key',
    } as ConstructorParameters<typeof LineHarness>[0])).toThrow('tenantId is required')
  })
})
