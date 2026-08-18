import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

describe('medication follow-up admin API', () => {
  it('schedules from a submission without accepting patient scope from the browser', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      followUp: { id: 'followup-a', status: 'scheduled', version: 1 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { medicationFollowUpApi } = await import('./api.js')

    await medicationFollowUpApi.schedule(
      'account-a', 'submission-a', '2026-08-21T00:00:00.000Z', 'request-a',
    )

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/custom/pharmacy/medication-followups?line_account_id=account-a'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          submissionId: 'submission-a',
          dueAt: '2026-08-21T00:00:00.000Z',
          idempotencyKey: 'request-a',
        }),
      }),
    )
  })

  it('sends an optimistic staff transition', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      followUp: { id: 'followup-a', status: 'assigned', version: 4 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { medicationFollowUpApi } = await import('./api.js')

    await medicationFollowUpApi.transition('account-a', 'followup-a', 'assigned', 3)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/followup-a/transitions?line_account_id=account-a'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'assigned', expectedVersion: 3 }) }),
    )
  })
})
