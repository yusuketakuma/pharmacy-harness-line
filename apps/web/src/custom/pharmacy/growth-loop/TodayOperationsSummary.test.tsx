import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  TodayOperationsSummaryView,
  createOperationsSummaryRequestGate,
  richMenuDisplayStatus,
  type OperationsSummary,
} from './TodayOperationsSummary'

const summary: OperationsSummary = {
  accountId: 'account-a',
  checkedAt: '2026-08-21T07:00:00.000Z',
  capabilityError: false,
  domains: {
    prescriptionIntake: { enabled: true, activeCount: 2, statusCounts: { received: 2 }, updatedAt: '2026-08-21T01:00:00.000Z', error: false },
    electronicPrescription: { enabled: false, activeCount: 1, statusCounts: { SUPPORT_NEEDED: 1 }, updatedAt: null, error: false },
    patientIntake: { enabled: true, activeCount: 0, statusCounts: {}, updatedAt: null, error: false },
    continuity: { enabled: true, activeCount: 3, statusCounts: { active: 3 }, updatedAt: null, error: false },
    medicationFollowup: { enabled: true, activeCount: 4, statusCounts: { due: 4 }, updatedAt: null, error: false },
    emergencyContraception: { enabled: false, activeCount: 0, statusCounts: {}, updatedAt: null, error: true },
  },
  richMenu: {
    status: 'UNVERIFIED', capabilityEnabled: true, layoutConfigured: true,
    savedVersionAvailable: true, catalogVersionCurrent: false,
    publishedVersionAvailable: true, currentDefaultRecorded: true, error: false,
  },
}

describe('today operations summary', () => {
  it('shows OFF drain, partial failure, readiness and keyboard deep links on a narrow grid', () => {
    const html = renderToStaticMarkup(<TodayOperationsSummaryView summary={summary} />)

    expect(html).toContain('本日の対応')
    expect(html).toContain('OFF（利用中）')
    expect(html).toContain('一部取得できません')
    expect(html).toContain('STALE')
    for (const href of ['/prescriptions', '/myna', '/patient-intakes', '/continuity', '/emergency-contraception', '/rich-menus']) {
      expect(html).toContain(`href="${href}"`)
    }
    expect(html).toContain('grid-cols-1')
    expect(html).toContain('min-h-11')
  })

  it('discards an old account response generation', () => {
    const gate = createOperationsSummaryRequestGate()
    const oldRequest = gate.start()
    const currentRequest = gate.start()

    expect(gate.isCurrent(oldRequest)).toBe(false)
    expect(gate.isCurrent(currentRequest)).toBe(true)
    gate.abort()
    expect(gate.isCurrent(currentRequest)).toBe(false)
  })

  it('distinguishes stale, blocked and unverified rich-menu readiness', () => {
    expect(richMenuDisplayStatus(summary.richMenu)).toBe('STALE')
    expect(richMenuDisplayStatus({ ...summary.richMenu, status: 'BLOCKED', catalogVersionCurrent: true })).toBe('BLOCKED')
    expect(richMenuDisplayStatus({ ...summary.richMenu, catalogVersionCurrent: true })).toBe('UNVERIFIED')
  })
})
