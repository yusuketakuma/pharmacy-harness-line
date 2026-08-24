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
    expect(page).toContain('emergencyContraceptionAdminApi.intakeDetail')
    expect(page).toContain('申告詳細を確認')
    expect(page).not.toContain('intake.self_reported')
    expect(page).not.toContain('checked={config.enabled}')
    expect(page).toContain('機能設定で変更')
  })

  it('keeps 販売可 scoped to the pharmacist entry section, not the neutral queue display', () => {
    const page = readFileSync(new URL('./EmergencyContraceptionAdminPage.tsx', import.meta.url), 'utf8')
    const entrySectionStart = page.indexOf('aria-label="薬剤師記入欄"')
    const entrySectionEnd = page.indexOf('</div>}', entrySectionStart)
    expect(entrySectionStart).toBeGreaterThan(-1)
    const outsideEntrySection = page.slice(0, entrySectionStart) + page.slice(entrySectionEnd)
    expect(outsideEntrySection).not.toContain('販売可')
    expect(page.slice(entrySectionStart, entrySectionEnd)).toContain('販売可')
  })

  it('supports bounded queue filtering and cursor pagination', () => {
    const page = readFileSync(new URL('./EmergencyContraceptionAdminPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('statusFilter')
    expect(page).toContain('slotFilter')
    expect(page).toContain('deadlineFilter')
    expect(page).toContain('nextCursor')
    expect(page).toContain('期限まで')
    expect(page).toContain('次を表示')
    expect(page).toContain('新しい受付から表示します')
    expect(page).not.toContain('未確認の仮受付を先に表示します')
  })

  it('shows every C2 menstruation signal for in-person reconciliation', () => {
    const page = readFileSync(new URL('./EmergencyContraceptionAdminPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('約1か月を超えて月経がない')
    expect(page).toContain('出産等の後に月経が回復していない')
    expect(page).toContain('今回より前の心配な出来事から3週間以上')
    expect(page).toContain("`menstruationSignals.${key}`")
  })

  it('shows an account-scoped neutral reminder switch keyed by its revision', () => {
    const page = readFileSync(new URL('./EmergencyContraceptionAdminPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('予約前の中立LINE通知')
    expect(page).toContain('emergencyContraceptionAdminApi.reminderControl')
    expect(page).toContain('expectedRevision: reminderControl.revision')
  })
})
