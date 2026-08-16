import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('prescription admin API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'csrf-token' })
  })

  it('scopes queue requests to the selected LINE account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null })))
    vi.stubGlobal('fetch', fetchMock)
    const { prescriptionAdminApi } = await import('./api.js')

    await prescriptionAdminApi.list('account/1')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/api/custom/pharmacy/prescriptions?line_account_id=account%2F1&limit=50',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('sends CSRF-protected conditional actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'accepted' })))
    vi.stubGlobal('fetch', fetchMock)
    const { prescriptionAdminApi } = await import('./api.js')

    await prescriptionAdminApi.action('account-1', 'submission-1', 'accept', '2026-08-17T00:00:00Z')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/api/custom/pharmacy/prescriptions/submission-1/actions/accept?line_account_id=account-1',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    )
  })
})
