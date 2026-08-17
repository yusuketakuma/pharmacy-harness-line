import { fetchApi } from '../../../lib/api'
import { accountQuery } from '../api'

export interface PharmacyPrintJob {
  id: string
  submission_id: string
  file_id: string
  revision: number
  status: 'queued' | 'claimed' | 'printed' | 'failed' | 'dead_letter' | 'cancelled'
}

export const pharmacyPrintApi = {
  list: (accountId: string) => fetchApi<{ jobs: PharmacyPrintJob[] }>(
    `/api/custom/pharmacy/print/jobs?${accountQuery(accountId)}&status=queued&limit=100`,
  ),
  claim: (accountId: string, jobId: string) => fetchApi<{ job: PharmacyPrintJob }>(
    `/api/custom/pharmacy/print/jobs/${encodeURIComponent(jobId)}/claim?${accountQuery(accountId)}`,
    { method: 'POST' },
  ),
  printed: (accountId: string, jobId: string) => fetchApi<{ job: PharmacyPrintJob }>(
    `/api/custom/pharmacy/print/jobs/${encodeURIComponent(jobId)}/printed?${accountQuery(accountId)}`,
    { method: 'POST' },
  ),
}
