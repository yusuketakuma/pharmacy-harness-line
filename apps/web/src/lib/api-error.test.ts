import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('fetchApi errors', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => '' })
  })

  it('keeps a structured server error available without changing the legacy message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: '処方せんの使用期限を確認してください' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )))
    const { fetchApi } = await import('./api.js')

    await expect(fetchApi('/api/test')).rejects.toMatchObject({
      status: 409,
      message: 'API error: 409',
      detail: '処方せんの使用期限を確認してください',
    })
  })

  it('clears browser session state and redirects immediately on 401', async () => {
    const removeItem = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign, pathname: '/prescriptions', search: '?submission=abc' } })
    vi.stubGlobal('localStorage', { getItem: () => '', removeItem })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'internal detail' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )))
    const { fetchApi } = await import('./api.js')

    await expect(fetchApi('/api/test')).rejects.toMatchObject({ status: 401 })
    expect(removeItem).toHaveBeenCalledWith('lh_csrf')
    expect(removeItem).toHaveBeenCalledWith('lh_selected_account')
    expect(assign).toHaveBeenCalledWith('/login?reason=expired&next=%2Fprescriptions%3Fsubmission%3Dabc')
  })
})
