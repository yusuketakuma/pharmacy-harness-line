import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('pharmacy activity notification API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'csrf-token' })
  })

  it('scopes reads to the selected account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ notifications: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const { pharmacyActivityApi } = await import('./api.js')
    await pharmacyActivityApi.list('account/1')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://worker.example/api/custom/pharmacy/activity-notifications?line_account_id=account%2F1',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('uses the approved PHI-free labels', async () => {
    const { activityTypeLabel } = await import('./api.js')
    expect(activityTypeLabel.prescription_received).toBe('処方せんを受信')
    expect(activityTypeLabel.patient_message_received).toBe('患者からメッセージ')
  })
})
