import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('data subject request admin API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'csrf-token' })
  })

  it('scopes every call to the selected LINE account', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ requests: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { dataSubjectRequestAdminApi } = await import('./api.js')

    await dataSubjectRequestAdminApi.list('account/1')
    await dataSubjectRequestAdminApi.resolve('account/1', 'request/1', {
      expectedVersion: 3, decision: 'rejected', outcomeNote: '説明済み',
    })

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://worker.example/api/custom/pharmacy/data-subject-requests?line_account_id=account%2F1',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://worker.example/api/custom/pharmacy/data-subject-requests/request%2F1/resolution?line_account_id=account%2F1',
    )
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'include' })
  })
})
