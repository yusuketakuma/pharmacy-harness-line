import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildOperationsSla,
  operationsDraftChanged,
  operationsDraftError,
  operationsDraftFrom,
  operationsMessageCodePatientLine,
  type OperationsDraft,
} from './MedicationFollowUpOperationsPanel'

const source = readFileSync(
  new URL('./MedicationFollowUpOperationsPanel.tsx', import.meta.url), 'utf8')

const savedOperations = {
  service_hours_text: '9:00-18:00',
  response_sla: { typical_minutes: 30, concern_minutes: 60 },
  primary_staff_id: 'staff-a',
  backup_staff_id: 'staff-b',
  after_hours_message_code: 'contact_pharmacy_during_hours' as const,
  emergency_message_code: 'seek_urgent_care' as const,
  enabled: true,
  version: 2,
  created_at: '2026-09-20T00:00:00.000Z',
  updated_at: '2026-09-20T00:00:00.000Z',
}

const validDraft: OperationsDraft = {
  serviceHoursText: '9:00-18:00',
  typicalMinutes: '30',
  concernMinutes: '60',
  pharmacistRequestedMinutes: '',
  assignedMinutes: '',
  escalatedMinutes: '',
  respondedMinutes: '',
  primaryStaffId: 'staff-a',
  backupStaffId: 'staff-b',
  afterHoursMessageCode: 'contact_pharmacy_during_hours',
  emergencyMessageCode: 'seek_urgent_care',
  enabled: true,
}

describe('medication follow-up operations panel helpers', () => {
  it('restores the saved draft including blank SLA fields', () => {
    expect(operationsDraftFrom(savedOperations)).toMatchObject({
      serviceHoursText: '9:00-18:00', typicalMinutes: '30', concernMinutes: '60',
      pharmacistRequestedMinutes: '', primaryStaffId: 'staff-a', backupStaffId: 'staff-b',
      enabled: true,
    })
    expect(operationsDraftFrom(null)).toMatchObject({
      primaryStaffId: '', enabled: false,
      afterHoursMessageCode: 'contact_pharmacy_during_hours',
      emergencyMessageCode: 'seek_urgent_care',
    })
  })

  it('serializes only filled SLA minute fields and rejects malformed input', () => {
    expect(buildOperationsSla(validDraft)).toEqual({ typical_minutes: 30, concern_minutes: 60 })
    expect(buildOperationsSla({ ...validDraft, typicalMinutes: ' ' })).toEqual({ concern_minutes: 60 })
    expect(buildOperationsSla({ ...validDraft, typicalMinutes: '30.5' })).toBeNull()
    expect(buildOperationsSla({ ...validDraft, typicalMinutes: '0' })).toBeNull()
    expect(buildOperationsSla({ ...validDraft, typicalMinutes: 'abc' })).toBeNull()
    expect(buildOperationsSla({ ...validDraft, typicalMinutes: '10081' })).toBeNull()
  })

  it('blocks the save with field-level errors before the API call', () => {
    expect(operationsDraftError(validDraft)).toBeNull()
    expect(operationsDraftError({ ...validDraft, serviceHoursText: ' ' }))
      .toContain('対応時間')
    expect(operationsDraftError({ ...validDraft, primaryStaffId: '' })).toContain('主担当')
    expect(operationsDraftError({ ...validDraft, backupStaffId: 'staff-a' }))
      .toContain('同じスタッフ')
    expect(operationsDraftError({ ...validDraft, typicalMinutes: '', enabled: true }))
      .toContain('通常の返信目安')
    // Disabled preconfiguration does not require the patient-facing estimate.
    expect(operationsDraftError({ ...validDraft, typicalMinutes: '', enabled: false })).toBeNull()
  })

  it('tracks dirty state against the saved config', () => {
    expect(operationsDraftChanged(operationsDraftFrom(savedOperations), savedOperations)).toBe(false)
    expect(operationsDraftChanged(
      { ...operationsDraftFrom(savedOperations), serviceHoursText: '10:00-19:00' },
      savedOperations,
    )).toBe(true)
    expect(operationsDraftChanged(operationsDraftFrom(null), null)).toBe(false)
  })

  it('previews the same fixed patient-facing lines as the LIFF page', () => {
    expect(operationsMessageCodePatientLine('contact_pharmacy_during_hours'))
      .toBe('営業時間外のご連絡は、次の営業時間に順次ご対応します。')
    expect(operationsMessageCodePatientLine('seek_urgent_care'))
      .toBe('お急ぎの症状がある場合は、返信を待たずに最寄りの医療機関へご相談ください。')
  })

  it('keeps optimistic locking, the enable confirmation, and the conflict reload in the panel', () => {
    expect(source).toContain('expectedVersion: operations?.version ?? 0')
    expect(source).toContain('cause instanceof ApiError && cause.status === 409')
    expect(source).toContain('最新の設定を再取得しました')
    expect(source).toContain('window.confirm')
    expect(source).toContain('患者画面に「対応の見通し」が表示されます')
    expect(source).not.toContain('method: \'PUT\'') // the mutation lives in api.ts
    expect(source).toContain('min-h-11')
    expect(source).toContain('disabled={!canMutate || !dirty || Boolean(validationError)')
    expect(source).toContain('まだ運用設定がありません')
    expect(source).toContain('role="alert"')
  })
})
