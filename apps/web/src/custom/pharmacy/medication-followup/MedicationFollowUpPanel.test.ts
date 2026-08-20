import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  eligibleMedicationFollowUpSubmissions,
  medicationFollowUpConfirmationMessage,
  medicationFollowUpAttentionLabel,
  medicationFollowUpActions,
  medicationFollowUpTimingLabel,
  minimumTokyoLocalValue,
  prescriptionFollowUpOptionLabel,
  requiresMedicationFollowUpConfirmation,
  sortMedicationFollowUpsForReview,
  toTokyoDueAt,
} from './MedicationFollowUpPanel'

describe('medication follow-up panel helpers', () => {
  it('reloads current data and explains an optimistic-lock conflict', () => {
    const source = readFileSync(new URL('./MedicationFollowUpPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('caught instanceof ApiError && caught.status === 409')
    expect(source).toContain('最新情報を読み込みました')
  })

  it('treats the datetime-local input as Asia/Tokyo', () => {
    const now = Date.parse('2026-08-19T00:00:00Z')
    expect(toTokyoDueAt('2026-08-21T10:30', now)).toBe('2026-08-21T01:30:00.000Z')
    expect(toTokyoDueAt('2026-08-18T10:30', now)).toBeNull()
    expect(toTokyoDueAt('invalid')).toBeNull()
    expect(minimumTokyoLocalValue(now)).toBe('2026-08-19T09:01')
  })

  it('identifies a prescription with its lifecycle timestamps and short id', () => {
    expect(prescriptionFollowUpOptionLabel({
      id: 'prescription-abcdef',
      active_revision: 2,
      closed_at: '2026-08-19T03:00:00Z',
      created_at: '2026-08-18T01:00:00Z',
    })).toContain('処方せん abcdef / 第2版 / お渡し')
  })

  it('shows the timestamp that matches the follow-up state', () => {
    const base = {
      due_at: '2026-08-20T00:00:00Z',
      delivered_at: '2026-08-20T00:01:00Z',
      responded_at: '2026-08-20T01:00:00Z',
      closed_at: '2026-08-20T02:00:00Z',
      updated_at: '2026-08-20T03:00:00Z',
    }
    expect(medicationFollowUpTimingLabel({ ...base, status: 'scheduled' })).toContain('送信予定')
    expect(medicationFollowUpTimingLabel({ ...base, status: 'delivered' })).toContain('送信済み')
    expect(medicationFollowUpTimingLabel({ ...base, status: 'concern' })).toContain('患者回答')
    expect(medicationFollowUpTimingLabel({ ...base, status: 'closed' })).toContain('終了')
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
    expect(medicationFollowUpActions('concern')).toEqual(['assigned', 'escalated'])
    expect(medicationFollowUpActions('assigned')).toEqual(['responded', 'escalated'])
    expect(medicationFollowUpActions('escalated')).toEqual(['responded'])
    expect(medicationFollowUpActions('responded')).toEqual(['closed'])
    expect(medicationFollowUpActions('closed')).toEqual([])
  })

  it('puts patient requests and concerns before routine rows', () => {
    const rows = [
      { id: 'scheduled', status: 'scheduled' as const, due_at: '2026-08-22T00:00:00Z', responded_at: null },
      { id: 'concern-new', status: 'concern' as const, due_at: '2026-08-21T00:00:00Z', responded_at: '2026-08-21T03:00:00Z' },
      { id: 'request', status: 'pharmacist_requested' as const, due_at: '2026-08-20T00:00:00Z', responded_at: '2026-08-20T03:00:00Z' },
      { id: 'concern-old', status: 'concern' as const, due_at: '2026-08-19T00:00:00Z', responded_at: '2026-08-19T03:00:00Z' },
    ]
    expect(sortMedicationFollowUpsForReview(rows).map((row) => row.id)).toEqual([
      'request', 'concern-old', 'concern-new', 'scheduled',
    ])
    expect(medicationFollowUpAttentionLabel('pharmacist_requested')).toBe('相談希望・要対応')
    expect(medicationFollowUpAttentionLabel('closed')).toBeNull()
  })

  it('confirms only irreversible transitions and uses an unambiguous cancel label', () => {
    expect(requiresMedicationFollowUpConfirmation('assigned')).toBe(false)
    expect(requiresMedicationFollowUpConfirmation('closed')).toBe(true)
    expect(requiresMedicationFollowUpConfirmation('cancelled')).toBe(true)
    expect(medicationFollowUpConfirmationMessage('cancelled')).toContain('フォローを取り消す')
    expect(medicationFollowUpConfirmationMessage('cancelled')).toContain('取り消せません')
  })

  it('distinguishes a saved reservation from a refresh failure and keeps action targets usable', () => {
    const panel = readFileSync(new URL('./MedicationFollowUpPanel.tsx', import.meta.url), 'utf8')

    expect(panel).toContain('予約は登録済みですが、最新情報を再取得できませんでした。')
    expect(panel).toContain('min-h-[44px]')
    expect(panel).toContain('患者回答')
    expect(panel).toContain('要対応')
    expect(panel).toContain('busyIds.has(item.id)')
  })
})
