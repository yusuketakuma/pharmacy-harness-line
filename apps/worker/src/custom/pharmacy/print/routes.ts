import { Hono, type Context } from 'hono'
import { getPharmacyAccountId } from '../account.js'
import { readJsonObject } from '../json.js'
import {
  assertPharmacyStaffInAccount,
  claimPharmacyPrintJob,
  listPharmacyPrintJobs,
  markPharmacyPrintJobFailed,
  markPharmacyPrintJobPrinted,
  retryPharmacyPrintJob,
  type PrintFailureCode,
  type PrintJobStatus,
} from './repository.js'

type PrintEnv = {
  Bindings: { DB: D1Database }
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } }
}

export const pharmacyPrintRoutes = new Hono<PrintEnv>()

const STATUSES = new Set<PrintJobStatus>(['queued', 'claimed', 'printed', 'failed', 'dead_letter', 'cancelled'])
const FAILURE_CODES = new Set<PrintFailureCode>([
  'printer_unavailable', 'paper_empty', 'ink_or_toner', 'invalid_document', 'unknown',
])

async function scopedStaff(c: Context<PrintEnv>): Promise<string | 'forbidden' | null> {
  const accountId = getPharmacyAccountId(c)
  const staff = c.get('staff')
  if (!accountId || !staff) return null
  if (!(await assertPharmacyStaffInAccount(c.env.DB, staff.id, accountId))) return 'forbidden'
  return accountId
}

pharmacyPrintRoutes.get('/api/custom/pharmacy/print/jobs', async (c) => {
  const accountId = await scopedStaff(c)
  if (!c.get('staff')) return c.json({ error: 'Unauthorized' }, 401)
  if (accountId === 'forbidden') return c.json({ error: 'Forbidden' }, 403)
  if (!accountId) return c.json({ error: 'line_account_id is required' }, 400)
  const statusParam = c.req.query('status') ?? 'queued'
  if (!STATUSES.has(statusParam as PrintJobStatus)) return c.json({ error: 'Invalid status' }, 400)
  const limit = Number(c.req.query('limit') ?? 50)
  if (!Number.isInteger(limit) || limit < 1) return c.json({ error: 'Invalid limit' }, 400)
  return c.json({ jobs: await listPharmacyPrintJobs(c.env.DB, accountId, statusParam as PrintJobStatus, limit) })
})

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/jobs/:id/claim', async (c) => {
  const accountId = await scopedStaff(c)
  const staff = c.get('staff')
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (accountId === 'forbidden') return c.json({ error: 'Forbidden' }, 403)
  if (!accountId) return c.json({ error: 'line_account_id is required' }, 400)
  const job = await claimPharmacyPrintJob(c.env.DB, accountId, c.req.param('id'), staff.id)
  return job ? c.json({ job }) : c.json({ error: 'Print job changed; retry' }, 409)
})

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/jobs/:id/printed', async (c) => {
  const accountId = await scopedStaff(c)
  const staff = c.get('staff')
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (accountId === 'forbidden') return c.json({ error: 'Forbidden' }, 403)
  if (!accountId) return c.json({ error: 'line_account_id is required' }, 400)
  const job = await markPharmacyPrintJobPrinted(c.env.DB, accountId, c.req.param('id'), staff.id)
  return job ? c.json({ job }) : c.json({ error: 'Print job changed; retry' }, 409)
})

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/jobs/:id/failed', async (c) => {
  const accountId = await scopedStaff(c)
  const staff = c.get('staff')
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (accountId === 'forbidden') return c.json({ error: 'Forbidden' }, 403)
  if (!accountId) return c.json({ error: 'line_account_id is required' }, 400)
  const body = await readJsonObject(c.req)
  const code = body?.code ?? body?.failureCode
  if (typeof code !== 'string' || !FAILURE_CODES.has(code as PrintFailureCode)) {
    return c.json({ error: 'Invalid failure code' }, 400)
  }
  const job = await markPharmacyPrintJobFailed(c.env.DB, accountId, c.req.param('id'), staff.id, code as PrintFailureCode)
  return job ? c.json({ job }) : c.json({ error: 'Print job changed; retry' }, 409)
})

pharmacyPrintRoutes.post('/api/custom/pharmacy/print/jobs/:id/retry', async (c) => {
  const accountId = await scopedStaff(c)
  const staff = c.get('staff')
  if (!staff) return c.json({ error: 'Unauthorized' }, 401)
  if (accountId === 'forbidden') return c.json({ error: 'Forbidden' }, 403)
  if (!accountId) return c.json({ error: 'line_account_id is required' }, 400)
  const job = await retryPharmacyPrintJob(c.env.DB, accountId, c.req.param('id'), staff.id)
  return job ? c.json({ job }) : c.json({ error: 'Print job cannot be retried' }, 409)
})
