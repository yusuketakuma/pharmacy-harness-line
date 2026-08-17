import { describe, expect, it, vi } from 'vitest'
import {
  claimPharmacyPrintJob,
  enqueuePrescriptionPrintJobs,
  markPharmacyPrintJobFailed,
  markPharmacyPrintJobPrinted,
  retryPharmacyPrintJob,
} from './repository.js'

describe('pharmacy print repository', () => {
  it('cancels queued jobs from superseded revisions before enqueueing the active files', async () => {
    const calls: string[] = []
    let firstQuery = true
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => {
            calls.push(sql)
            if (firstQuery) {
              firstQuery = false
              return { id: 'submission-1', active_revision: 2 }
            }
            return null
          },
          all: async () => {
            calls.push(sql)
            if (sql.includes('pharmacy_prescription_files')) {
              return { results: [{ id: 'file-2', revision: 2 }] }
            }
            return { results: [{ id: 'old-job', attempt_count: 1 }] }
          },
          run: async () => {
            calls.push(sql)
            return { meta: { changes: sql.startsWith('UPDATE pharmacy_print_jobs') ? 1 : 0 } }
          },
        }),
      })),
    } as unknown as D1Database

    await expect(enqueuePrescriptionPrintJobs(db, 'account-1', 'submission-1')).resolves.toBe(0)
    expect(calls.some((sql) => sql.includes("status = 'cancelled'"))).toBe(true)
    expect(calls.some((sql) => sql.includes('pharmacy_print_events'))).toBe(true)
  })

  function transitionDb(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    readBefore = true,
  ) {
    let reads = 0
    const calls: string[] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: (..._values: unknown[]) => ({
          first: async () => {
            calls.push(sql)
            if (sql.includes('FROM pharmacy_print_jobs')) {
              return readBefore && reads++ === 0 ? before : after
            }
            return null
          },
          all: async () => ({ results: [] }),
          run: async () => {
            calls.push(sql)
            return { meta: { changes: 1 } }
          },
        }),
      })),
    } as unknown as D1Database
    return { db, calls }
  }

  it('claims a job with a lease and records printed/failure transitions without free text', async () => {
    const queued = {
      id: 'job-1', line_account_id: 'account-1', submission_id: 'submission-1', file_id: 'file-1',
      revision: 1, status: 'queued', attempt_count: 0, available_at: '2026-08-18T00:00:00.000Z',
      claimed_by: null, claimed_at: null, lease_until: null, printed_at: null,
      last_failure_code: null, created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    }
    const claimed = { ...queued, status: 'claimed', attempt_count: 1, claimed_by: 'staff-1', lease_until: '2026-08-18T00:05:00.000Z' }
    const claimedDb = transitionDb(queued, claimed)
    await expect(claimPharmacyPrintJob(
      claimedDb.db, 'account-1', 'job-1', 'staff-1', new Date('2026-08-18T00:00:00.000Z'),
    )).resolves.toEqual(claimed)
    expect(claimedDb.calls.some((sql) => sql.includes('attempt_count = attempt_count + 1'))).toBe(true)

    const printed = { ...claimed, status: 'printed', printed_at: '2026-08-18T00:00:01.000Z' }
    const printedDb = transitionDb(claimed, printed, false)
    await expect(markPharmacyPrintJobPrinted(
      printedDb.db, 'account-1', 'job-1', 'staff-1', new Date('2026-08-18T00:00:01.000Z'),
    )).resolves.toEqual(printed)
    expect(printedDb.calls.some((sql) => sql.includes("status = 'printed'"))).toBe(true)

    const failed = { ...claimed, status: 'failed', last_failure_code: 'paper_empty' }
    const failedDb = transitionDb(claimed, failed)
    await expect(markPharmacyPrintJobFailed(
      failedDb.db, 'account-1', 'job-1', 'staff-1', 'paper_empty', new Date('2026-08-18T00:00:01.000Z'),
    )).resolves.toEqual(failed)
    expect(failedDb.calls.some((sql) => sql.includes('failure_code'))).toBe(true)
  })

  it('manually retries only terminal retryable states and resets the attempt budget', async () => {
    const deadLetter = {
      id: 'job-1', line_account_id: 'account-1', submission_id: 'submission-1', file_id: 'file-1',
      revision: 1, status: 'dead_letter', attempt_count: 3, available_at: '2026-08-18T00:00:00.000Z',
      claimed_by: null, claimed_at: null, lease_until: null, printed_at: null,
      last_failure_code: 'printer_unavailable', created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    }
    const queued = { ...deadLetter, status: 'queued', attempt_count: 0, last_failure_code: null }
    const fake = transitionDb(deadLetter, queued, false)
    await expect(retryPharmacyPrintJob(
      fake.db, 'account-1', 'job-1', 'staff-1', new Date('2026-08-18T00:00:00.000Z'),
    )).resolves.toEqual(queued)
    expect(fake.calls.some((sql) => sql.includes("status IN ('failed','dead_letter','cancelled')"))).toBe(true)
  })
})
