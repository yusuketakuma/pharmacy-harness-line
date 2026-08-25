import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('pharmacy image upload account scope', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => '' })
  })

  it('sends the selected account as a server-validated selector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { id: 'image-a', key: 'key-a', url: 'https://image.example/a', mimeType: 'image/png', size: 1 },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const { api } = await import('../../../lib/api.js')
    const file = {
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    } as File

    await api.uploads.image(file, 'account a')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/api/images?line_account_id=account%20a',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
