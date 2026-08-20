import { describe, expect, it, vi } from 'vitest'
import { endNextIntakeExpectation } from './next-intake.js'

function fakeDb(firstRows: unknown[]) {
  const rows = [...firstRows]
  const calls: Array<{ sql: string; values: unknown[]; operation: string }> = []
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      sql,
      values,
      first: async () => {
        calls.push({ sql, values, operation: 'first' })
        return rows.shift() ?? null
      },
    }),
  }))
  const batch = vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
    calls.push(...statements.map(({ sql, values }) => ({ sql, values, operation: 'batch' })))
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  })
  return { db: { prepare, batch } as unknown as D1Database, calls }
}

describe('next-intake staff cancellation', () => {
  it('ends the account-scoped expectation and its staff audit event atomically', async () => {
    const current = { id: 'expectation-1', status: 'accepted', version: 2 }
    const ended = { ...current, status: 'ended', version: 3 }
    const { db, calls } = fakeDb([current, current, null, ended])

    await expect(endNextIntakeExpectation(db, {
      lineAccountId: 'account-1',
      expectationId: 'expectation-1',
      expectedVersion: 2,
      staffId: 'staff-1',
      idempotencyKey: 'end-request-1',
      now: new Date('2026-08-19T00:00:00Z'),
    })).resolves.toMatchObject({ status: 'ended', version: 3 })

    const batched = calls.filter((call) => call.operation === 'batch')
    expect(batched).toHaveLength(2)
    expect(batched[0].sql).toContain('pharmacy_next_intake_expectation_events')
    expect(batched[0].values).toContain('staff')
    expect(batched[1].sql).toContain('UPDATE pharmacy_next_intake_expectations')
    expect(batched[1].values).toContain('account-1')
  })
})
