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

it('suspends a binding with the fixed non-clinical reason', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    status: 'suspended', controlVersion: 1,
    nextAction: 'recreate_under_verified_owner',
  })))
  vi.stubGlobal('fetch', fetchMock)
  const { pharmacyIntakeAdminApi } = await import('./api.js')

  await pharmacyIntakeAdminApi.suspendBinding('account-1', 'patient-1')

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/patients/patient-1/binding-suspension?line_account_id=account-1'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ reasonCode: 'wrong_line_binding' }),
    }),
  )
})
