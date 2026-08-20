import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privacyPolicyIssues } from './PrivacyPolicyAdminPage.js'

describe('pharmacy tenant privacy policy admin', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'csrf-token' })
  })

  it('scopes reads and writes to the selected LINE account', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ policy: null })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { pharmacyPrivacyPolicyApi } = await import('./api.js')

    await pharmacyPrivacyPolicyApi.get('account/1')
    await pharmacyPrivacyPolicyApi.save('account-1', {
      purposeText: '調剤のため', purposeUrl: '', contactPoint: '窓口', entrustmentText: '委託あり',
    })

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://worker.example/api/custom/pharmacy/privacy-policy?line_account_id=account%2F1', undefined],
      ['https://worker.example/api/custom/pharmacy/privacy-policy?line_account_id=account-1', 'PUT'],
    ])
  })

  it('blocks saving until the tenant-authored fields are complete and the URL is https', () => {
    expect(privacyPolicyIssues({
      purposeText: '', purposeUrl: '', contactPoint: '', entrustmentText: '',
    })).toEqual(['利用目的', '問い合わせ窓口', '委託関係の説明'])
    expect(privacyPolicyIssues({
      purposeText: '調剤のため', purposeUrl: 'http://example.com', contactPoint: '窓口',
      entrustmentText: '委託あり',
    })).toHaveLength(1)
    expect(privacyPolicyIssues({
      purposeText: '調剤のため', purposeUrl: '', contactPoint: '窓口', entrustmentText: '委託あり',
    })).toEqual([])
  })

  it('presents the pharmacy as the data controller and the platform as the processor', () => {
    const page = readFileSync(new URL('./PrivacyPolicyAdminPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('個人情報取扱事業者となるのは貴薬局です')
    expect(page).toContain('受託者')
  })
})
