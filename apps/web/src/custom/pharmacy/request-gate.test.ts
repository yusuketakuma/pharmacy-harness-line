import { describe, expect, it } from 'vitest'
import { createRequestGate } from './request-gate'
import { createRequestGate as createMynaRequestGate } from './myna/MynaAdminPage'
import { createOperationsSummaryRequestGate } from './growth-loop/TodayOperationsSummary'

describe('shared request gate', () => {
  it('keeps the public factory aliases and independent generations', () => {
    expect(createMynaRequestGate).toBe(createRequestGate)
    expect(createOperationsSummaryRequestGate).toBe(createRequestGate)

    const first = createRequestGate()
    const second = createRequestGate()
    const token = first.start()
    expect(first.isCurrent(token)).toBe(true)
    expect(second.isCurrent(token)).toBe(false)
    first.abort()
    expect(first.isCurrent(token)).toBe(false)
    expect(first.start()).toBe(token + 2)
  })
})
