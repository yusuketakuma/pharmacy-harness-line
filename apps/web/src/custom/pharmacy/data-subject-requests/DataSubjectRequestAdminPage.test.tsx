import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_IS_NOT_ERASURE_NOTICE,
  NO_OUTBOUND_NOTICE,
  legalHoldExplanation,
  remainingRetentionText,
  requestStatusLabel,
  requestTypeLabel,
  resolutionConfirmationMessage,
} from './DataSubjectRequestAdminPage.js'

const NOW = new Date('2026-08-20T00:00:00.000Z')
const page = readFileSync(new URL('./DataSubjectRequestAdminPage.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../../components/layout/sidebar.tsx', import.meta.url), 'utf8')

describe('data subject request labels', () => {
  it('names all four APPI request types and every workflow state', () => {
    expect(requestTypeLabel('access')).toBe('開示請求')
    expect(requestTypeLabel('correction')).toBe('訂正請求')
    expect(requestTypeLabel('suspension')).toBe('利用停止請求')
    expect(requestTypeLabel('erasure')).toBe('消去請求')
    expect(requestStatusLabel('received')).toBe('受付')
    expect(requestStatusLabel('identity_verified')).toBe('本人確認済み')
    expect(requestStatusLabel('legal_hold_assessed')).toBe('法定保存判定済み')
    expect(requestStatusLabel('resolved')).toBe('対応済み')
    expect(requestStatusLabel('rejected')).toBe('対応不可として記録')
  })
})

describe('legal hold explanation', () => {
  it('explains an unresolved assessment without implying a verdict', () => {
    expect(legalHoldExplanation({
      legal_hold: null, legal_hold_release_at: null, request_type: 'erasure',
    }, NOW)).toContain('判定がまだです')
  })

  it('refuses erasure while the statutory retention period still runs', () => {
    const text = legalHoldExplanation({
      legal_hold: 1, legal_hold_release_at: '2027-08-20T00:00:00.000Z', request_type: 'erasure',
    }, NOW)
    expect(text).toContain('薬剤師法施行規則')
    expect(text).toContain('法定保存期間中')
    expect(text).toContain('あと約1年')
    expect(text).toContain('消去・利用停止には応じられません')
  })

  it('allows erasure once the 3-year period has passed', () => {
    expect(legalHoldExplanation({
      legal_hold: 0, legal_hold_release_at: '2023-01-01T00:00:00.000Z', request_type: 'erasure',
    }, NOW)).toContain('法定保存期間(3年)を経過しているため、対応可能です')
  })

  it('does not refuse an access request during the retention period', () => {
    const text = legalHoldExplanation({
      legal_hold: 1, legal_hold_release_at: '2027-08-20T00:00:00.000Z', request_type: 'access',
    }, NOW)
    expect(text).toContain('開示・訂正は保存義務と両立するため対応できます')
    expect(text).not.toContain('応じられません')
  })

  it('reports the remaining period in months when under a year', () => {
    expect(remainingRetentionText('2026-11-20T00:00:00.000Z', NOW)).toBe('あと約4か月')
    expect(remainingRetentionText('2028-02-20T00:00:00.000Z', NOW)).toBe('あと約1年7か月')
  })
})

describe('destructive-action safety', () => {
  it('warns that both resolutions are irreversible and not a patient notification', () => {
    const resolved = resolutionConfirmationMessage('resolved', { request_type: 'erasure' })
    const rejected = resolutionConfirmationMessage('rejected', { request_type: 'erasure' })
    expect(resolved).toContain('消去請求')
    expect(resolved).toContain('取り消せません')
    expect(resolved).toContain('よろしいですか？')
    expect(resolved).toContain('本人への結果連絡はこの画面からは送信されない')
    expect(rejected).toContain('取り消せません')
    expect(rejected).toContain('よろしいですか？')
  })

  it('confirms, single-flights, and never reports a failure silently', () => {
    expect(page).toContain('window.confirm')
    expect(page).toContain('const [busy, setBusy]')
    expect(page).toContain("disabled={busy !== ''}")
    expect(page).toContain('role="alert"')
    expect(page).toContain('role="status"')
    expect(page).toContain('min-h-11')
    expect(page).toContain("timeZone: 'Asia/Tokyo'")
    expect(page).toContain('requestGate.abort()')
  })

  it('states that archiving is not a substitute for a resolved erasure request', () => {
    expect(ARCHIVE_IS_NOT_ERASURE_NOTICE).toContain('通常業務の一覧から隠すだけ')
    expect(ARCHIVE_IS_NOT_ERASURE_NOTICE).toContain('法的な消去対応にはならない')
    expect(NO_OUTBOUND_NOTICE).toContain('この画面からは送信されません')
    expect(page).toContain('ARCHIVE_IS_NOT_ERASURE_NOTICE')
    expect(page).toContain('NO_OUTBOUND_NOTICE')
  })

  it('is reachable from the pharmacy menu', () => {
    expect(sidebar).toContain("href: '/data-subject-requests'")
    expect(sidebar).toContain('// custom:pharmacy-data-subject-requests')
  })
})
