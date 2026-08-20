import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('emergency contraception admin API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://worker.example')
    vi.stubGlobal('window', {})
    vi.stubGlobal('localStorage', { getItem: () => 'csrf-token' })
  })

  it('scopes config and queue reads to the selected LINE account', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: null, pharmacists: [], inventory: [], slots: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ intakes: [], next_cursor: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ intake: { id: 'intake-1' } })))
    vi.stubGlobal('fetch', fetchMock)
    const { emergencyContraceptionAdminApi } = await import('./api.js')

    await emergencyContraceptionAdminApi.config('account/1')
    await emergencyContraceptionAdminApi.intakes('account/1', {
      status: 'provisional', slotId: 'slot/1',
      deadlineBefore: '2026-08-22T00:00:00.000Z', cursor: 'cursor/1', limit: 20,
    })
    await emergencyContraceptionAdminApi.intakeDetail('account/1', 'intake/1')

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://worker.example/api/custom/pharmacy/emergency-contraception/config?line_account_id=account%2F1',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://worker.example/api/custom/pharmacy/emergency-contraception/intakes?line_account_id=account%2F1&status=provisional&slotId=slot%2F1&deadlineBefore=2026-08-22T00%3A00%3A00.000Z&cursor=cursor%2F1&limit=20',
    )
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://worker.example/api/custom/pharmacy/emergency-contraception/intakes/intake%2F1?line_account_id=account%2F1',
    )
  })

  it('uses the Worker route contract for staff mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const { emergencyContraceptionAdminApi } = await import('./api.js')

    await emergencyContraceptionAdminApi.saveConfig('account-1', { enabled: false, purposeText: '対面相談受付' } as never)
    await emergencyContraceptionAdminApi.setPharmacist('account-1', 'staff-1', {
      registrationNumber: 'TRAIN-1', active: true,
    })
    await emergencyContraceptionAdminApi.createSlot('account-1', {
      pharmacistStaffId: 'staff-1', startsAt: '2026-08-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:30:00.000Z', capacity: 1,
    })
    await emergencyContraceptionAdminApi.cancelSlot('account-1', 'slot-1', 1)
    await emergencyContraceptionAdminApi.setInventory('account-1', {
      productCode: 'norlevo-otc', onHand: 2, expectedVersion: 1,
    })
    await emergencyContraceptionAdminApi.transition('account-1', 'intake-1', 'completed', 1)

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['https://worker.example/api/custom/pharmacy/emergency-contraception/config?line_account_id=account-1', 'PUT', JSON.stringify({ purposeText: '対面相談受付' })],
      ['https://worker.example/api/custom/pharmacy/emergency-contraception/pharmacists/staff-1?line_account_id=account-1', 'PUT', JSON.stringify({ registrationNumber: 'TRAIN-1', active: true })],
      ['https://worker.example/api/custom/pharmacy/emergency-contraception/slots?line_account_id=account-1', 'POST', JSON.stringify({ pharmacistStaffId: 'staff-1', startsAt: '2026-08-20T00:00:00.000Z', endsAt: '2026-08-20T00:30:00.000Z', capacity: 1 })],
      ['https://worker.example/api/custom/pharmacy/emergency-contraception/slots/slot-1/cancel?line_account_id=account-1', 'POST', JSON.stringify({ expectedVersion: 1 })],
      ['https://worker.example/api/custom/pharmacy/emergency-contraception/inventory?line_account_id=account-1', 'PUT', JSON.stringify({ productCode: 'norlevo-otc', onHand: 2, expectedVersion: 1 })],
      ['https://worker.example/api/custom/pharmacy/emergency-contraception/intakes/intake-1/transitions?line_account_id=account-1', 'POST', JSON.stringify({ status: 'completed', expectedVersion: 1 })],
    ])
  })
})
