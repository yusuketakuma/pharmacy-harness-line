import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  emergencyReadinessIssues,
  emergencyIntakeStatusLabel,
  emergencyRiskFlagLabel,
  inventoryConfirmationMessage,
  localDateTimeToIso,
  transitionConfirmationMessage,
} from './EmergencyContraceptionAdminPage.js'

describe('emergency contraception admin safety', () => {
  it('labels risk flags and keeps completed as a paper-recorded counter status', () => {
    expect(emergencyRiskFlagLabel('time_unknown')).toBe('性交時刻が不明')
    expect(emergencyRiskFlagLabel('repeat_purchase_review')).toBe('直近購入の確認が必要')
    expect(emergencyIntakeStatusLabel('completed')).toContain('店頭対応完了')
    expect(emergencyIntakeStatusLabel('completed')).toContain('販売実績は紙記録')
  })

  it('requires explicit confirmation for cancellation and completion', () => {
    expect(transitionConfirmationMessage('cancelled')).toContain('取消')
    expect(transitionConfirmationMessage('completed')).toContain('販売実績は紙記録')
    expect(transitionConfirmationMessage('completed')).toContain('最終適格性')
    expect(transitionConfirmationMessage('expired')).toContain('期限切れ')
    expect(inventoryConfirmationMessage('norlevo-otc', 2)).toContain('在庫数を2')
  })

  it('treats datetime-local input as JST and explains incomplete readiness', () => {
    expect(localDateTimeToIso('2026-08-20T09:30')).toBe('2026-08-20T09:30:00+09:00')
    expect(emergencyReadinessIssues({
      enabled: true,
      pharmacyRegistrationNumber: '', productCode: '', purposeText: '',
      manufacturerCheckUrl: '', privacyPolicyUrl: '', privacyContact: '', consentVersion: '',
      retentionDays: 30, consultationMinutes: 30, reservationTtlMinutes: 30,
      privacySpaceReady: false, drinkingWaterReady: false,
      partnerClinicUrl: '', supportCenterUrl: '',
    }, [], [], [])).toEqual(expect.arrayContaining([
      '薬局登録番号', '研修修了薬剤師', '在庫', '対応枠',
    ]))
  })

  it('resets account-scoped state and avoids automatic eligibility or sale claims', () => {
    const page = readFileSync(new URL('./EmergencyContraceptionAdminPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('setConfig(emptyConfig)')
    expect(page).toContain('setIntakes([])')
    expect(page).toContain('最終適格性・販売の可否を自動判定しません')
    expect(page).toContain('window.confirm')
    expect(page).toContain('コード上の受付条件')
    expect(page).not.toContain('販売可')
  })
})
