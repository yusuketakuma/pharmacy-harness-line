import { describe, expect, it } from 'vitest'
import {
  eligibleMedicationFollowUpSubmissions,
  medicationFollowUpActions,
  toTokyoDueAt,
} from './MedicationFollowUpPanel'

describe('medication follow-up panel helpers', () => {
  it('treats the datetime-local input as Asia/Tokyo', () => {
    expect(toTokyoDueAt('2026-08-21T10:30')).toBe('2026-08-21T01:30:00.000Z')
    expect(toTokyoDueAt('invalid')).toBeNull()
  })

  it('offers only closed submissions that do not already own a follow-up', () => {
    expect(eligibleMedicationFollowUpSubmissions([
      { id: 'closed-a', status: 'closed', created_at: '2026-08-18' },
      { id: 'ready-b', status: 'ready', created_at: '2026-08-18' },
      { id: 'closed-c', status: 'closed', created_at: '2026-08-17' },
    ], [{ source_submission_id: 'closed-c' }])).toEqual([
      { id: 'closed-a', status: 'closed', created_at: '2026-08-18' },
    ])
  })

  it('shows only staff transitions valid for the current state', () => {
    expect(medicationFollowUpActions('scheduled')).toEqual(['cancelled'])
    expect(medicationFollowUpActions('concern')).toEqual(['assigned', 'escalated', 'closed'])
    expect(medicationFollowUpActions('closed')).toEqual([])
  })
})
