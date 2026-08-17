import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mocks = vi.hoisted(() => ({
  assert: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  printed: vi.fn(),
  failed: vi.fn(),
  retry: vi.fn(),
}))

vi.mock('./repository.js', () => ({
  assertPharmacyStaffInAccount: mocks.assert,
  listPharmacyPrintJobs: mocks.list,
  claimPharmacyPrintJob: mocks.claim,
  markPharmacyPrintJobPrinted: mocks.printed,
  markPharmacyPrintJobFailed: mocks.failed,
  retryPharmacyPrintJob: mocks.retry,
}))

import { pharmacyPrintRoutes } from './routes.js'

const env = { DB: {} as D1Database }

function app(withStaff = true) {
  const root = new Hono<{
    Bindings: { DB: D1Database }
    Variables: { staff: { id: string; name: string; role: 'admin' } }
  }>()
  root.use('*', async (c, next) => {
    if (withStaff) c.set('staff', { id: 'staff-1', name: 'Staff', role: 'admin' })
    await next()
  })
  root.route('/', pharmacyPrintRoutes)
  return root
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.assert.mockResolvedValue(true)
  mocks.list.mockResolvedValue([{ id: 'job-1', status: 'queued' }])
  mocks.claim.mockResolvedValue({ id: 'job-1', status: 'claimed' })
  mocks.printed.mockResolvedValue({ id: 'job-1', status: 'printed' })
  mocks.failed.mockResolvedValue({ id: 'job-1', status: 'failed' })
  mocks.retry.mockResolvedValue({ id: 'job-1', status: 'queued' })
})

describe('pharmacy print routes', () => {
  it('requires staff authentication and server-side account membership', async () => {
    await expect(app(false).request('/api/custom/pharmacy/print/jobs?line_account_id=account-1', {}, env))
      .resolves.toHaveProperty('status', 401)
    mocks.assert.mockResolvedValue(false)
    const response = await app().request('/api/custom/pharmacy/print/jobs?line_account_id=account-1', {}, env)
    expect(response.status).toBe(403)
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('lists jobs only after membership verification', async () => {
    const response = await app().request('/api/custom/pharmacy/print/jobs?line_account_id=account-1&status=queued', {}, env)
    expect(response.status).toBe(200)
    expect(mocks.assert).toHaveBeenCalledWith(env.DB, 'staff-1', 'account-1')
    expect(mocks.list).toHaveBeenCalledWith(env.DB, 'account-1', 'queued', 50)
  })

  it('does not accept arbitrary failure codes', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/print/jobs/job-1/failed?line_account_id=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'patient_name' }) },
      env,
    )
    expect(response.status).toBe(400)
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('rejects a JSON null failure body without throwing', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/print/jobs/job-1/failed?line_account_id=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' },
      env,
    )
    expect(response.status).toBe(400)
    expect(mocks.failed).not.toHaveBeenCalled()
  })

  it('exposes manual retry without accepting an account from the body', async () => {
    const response = await app().request(
      '/api/custom/pharmacy/print/jobs/job-1/retry?line_account_id=account-1',
      { method: 'POST' },
      env,
    )
    expect(response.status).toBe(200)
    expect(mocks.retry).toHaveBeenCalledWith(env.DB, 'account-1', 'job-1', 'staff-1')
  })
})
