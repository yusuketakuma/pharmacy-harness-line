import { beforeEach, describe, expect, it, vi } from 'vitest'
const fetchApi = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/api', () => ({ fetchApi }))
import { pharmacyPublicProfileAdminApi } from './api'

beforeEach(() => vi.clearAllMocks())

describe('pharmacy public profile admin API', () => {
  it('scopes reads and writes to the selected account', async () => {
    fetchApi.mockResolvedValue({ profile: null })
    await pharmacyPublicProfileAdminApi.get('account/1')
    await pharmacyPublicProfileAdminApi.save('account/1', { displayName: 'みどり薬局' } as never)
    expect(fetchApi.mock.calls).toEqual([
      ['/api/custom/pharmacy/public-profile?line_account_id=account%2F1'],
      ['/api/custom/pharmacy/public-profile?line_account_id=account%2F1', {
        method: 'PUT', body: JSON.stringify({ displayName: 'みどり薬局' }),
      }],
    ])
  })
})
