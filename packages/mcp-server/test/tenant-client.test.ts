import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('tenant-bound MCP client', () => {
  it('requires and forwards LINE_HARNESS_TENANT_ID', async () => {
    vi.stubEnv('LINE_HARNESS_API_URL', 'https://worker.example.test')
    vi.stubEnv('LINE_HARNESS_API_KEY', 'integration-key')
    vi.stubEnv('LINE_HARNESS_TENANT_ID', 'tenant-a')
    const request = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { items: [], total: 0, page: 1, limit: 50, hasNextPage: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', request)

    const { getClient } = await import('../src/client.js')
    await getClient().friends.list()

    const headers = new Headers(request.mock.calls[0][1]?.headers)
    expect(headers.get('X-Tenant-Id')).toBe('tenant-a')
  })

  it('fails closed when tenant scope is absent', async () => {
    vi.stubEnv('LINE_HARNESS_API_URL', 'https://worker.example.test')
    vi.stubEnv('LINE_HARNESS_API_KEY', 'integration-key')
    vi.stubEnv('LINE_HARNESS_TENANT_ID', '')
    const { getClient } = await import('../src/client.js')

    expect(() => getClient()).toThrow('LINE_HARNESS_TENANT_ID')
  })
})
