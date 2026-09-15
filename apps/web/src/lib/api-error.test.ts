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

  it('fails closed before a mutation when the CSRF token is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => '' })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi, SessionStateUnavailableError } = await import('./api.js')

    await expect(fetchApi('/api/test', { method: 'POST' })).rejects.toBeInstanceOf(SessionStateUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports unavailable browser storage instead of continuing a mutation', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('storage denied') } })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi, BrowserStorageUnavailableError } = await import('./api.js')

    await expect(fetchApi('/api/test', { method: 'PATCH' })).rejects.toBeInstanceOf(BrowserStorageUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a CSRF token before persisting an authenticated session', async () => {
    const { persistStaffSession, SessionStateUnavailableError } = await import('./api.js')

    expect(() => persistStaffSession({ data: { name: 'staff' } }))
      .toThrow(SessionStateUnavailableError)
  })

  it('rejects incomplete or unsafe staff sessions before writing browser state', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => '', setItem })
    const { persistStaffSession, SessionStateUnavailableError } = await import('./api.js')
    const data = {
      id: 'staff-1',
      name: 'Staff',
      role: 'staff',
      principalKind: 'human',
      tenantId: 'tenant-1',
      tenantCode: 'pharmacy-1',
      tenantName: 'Pharmacy',
      mustChangePassword: false,
    }

    for (const session of [
      { success: true, csrfToken: 'csrf-token', data: {} },
      { success: false, csrfToken: 'csrf-token', data },
      { success: true, csrfToken: '  ', data },
      { success: true, csrfToken: 'csrf\u0000token', data },
    ]) {
      expect(() => persistStaffSession(session)).toThrow(SessionStateUnavailableError)
    }
    expect(setItem).not.toHaveBeenCalled()
  })

  it('rejects whitespace and control characters before a mutation is sent', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { fetchApi, SessionStateUnavailableError } = await import('./api.js')

    for (const token of ['   ', '\tcsrf-token', 'csrf-token\u0000']) {
      vi.stubGlobal('localStorage', { getItem: () => token })
      await expect(fetchApi('/api/test', { method: 'POST' }))
        .rejects.toBeInstanceOf(SessionStateUnavailableError)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
