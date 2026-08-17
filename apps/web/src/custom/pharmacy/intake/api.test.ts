import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it('forwards the account-list abort signal to fetch', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ patients: [] })))
  vi.stubGlobal('fetch', fetchMock)
  const { pharmacyIntakeAdminApi } = await import('./api.js')
  const controller = new AbortController()

  await pharmacyIntakeAdminApi.list('account-1', controller.signal)

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('line_account_id=account-1'),
    expect.objectContaining({ signal: controller.signal }),
  )
})
